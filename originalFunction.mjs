import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { OpenAI } from "openai";
import ffmpeg from "fluent-ffmpeg";
import { createWriteStream, createReadStream } from "fs";
import { pipeline } from "stream/promises";
import { promises as fs } from "fs";
import { File } from "buffer";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const ffmpegPath = "/opt/bin/ffmpeg";
ffmpeg.setFfmpegPath(ffmpegPath);

const s3Client = new S3Client({ region: "sa-east-1" });
const snsClient = new SNSClient({ region: "sa-east-1" });
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getOptimizedChunkConfig(audioSizeInMB) {
  const MAX_CHUNK_SIZE = 20 * 1024 * 1024; // 20MB - safe limit under Whisper's 25MB
  const MIN_CHUNK_SIZE = 4 * 1024 * 1024; // 4MB minimum

  let optimalConfig = {
    chunkSize: MAX_CHUNK_SIZE,
    concurrentRequests: 4,
  };

  if (audioSizeInMB < 25) {
    // For small files, split into 2-3 chunks
    optimalConfig.chunkSize = Math.max(
      MIN_CHUNK_SIZE,
      Math.floor((audioSizeInMB * 1024 * 1024) / 2)
    );
    optimalConfig.concurrentRequests = 2;
  } else if (audioSizeInMB < 50) {
    // For medium files, aim for 3-4 chunks
    optimalConfig.chunkSize = Math.max(
      MIN_CHUNK_SIZE,
      Math.floor((audioSizeInMB * 1024 * 1024) / 3)
    );
    optimalConfig.concurrentRequests = 3;
  } else {
    // For larger files, optimize for parallel processing
    const numberOfChunks = Math.ceil(audioSizeInMB / 20); // ~20MB per chunk
    optimalConfig.chunkSize = Math.floor(
      (audioSizeInMB * 1024 * 1024) / numberOfChunks
    );
    optimalConfig.concurrentRequests = Math.min(4, numberOfChunks);
  }

  console.log(`Optimized config for ${audioSizeInMB}MB of audio:`, {
    chunkSizeMB: Math.round(optimalConfig.chunkSize / 1024 / 1024),
    concurrentRequests: optimalConfig.concurrentRequests,
    estimatedChunks: Math.ceil(
      (audioSizeInMB * 1024 * 1024) / optimalConfig.chunkSize
    ),
  });

  return optimalConfig;
}

async function transcribeChunkWithRetry(chunkBuffer, index, retryCount = 0) {
  try {
    console.log(`Chunk ${index}: size = ${chunkBuffer.length} bytes`);

    const audioFile = new File([chunkBuffer], "chunk.mp3", {
      type: "audio/mp3",
    });
    console.log(`Processing chunk ${index}, attempt ${retryCount + 1}`);

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      language: "es",
      response_format: "json",
    });

    console.log(
      `Chunk ${index}: Successfully transcribed, text length: ${transcription.text.length} characters`
    );
    return { success: true, text: transcription.text, index };
  } catch (error) {
    console.error(`Chunk ${index} error: ${error.message}`);
    console.error(
      `Chunk ${index} error details:`,
      JSON.stringify({
        status: error.status,
        type: error.type,
        code: error.code,
        param: error.param,
      })
    );

    if (retryCount < MAX_RETRIES) {
      const backoffTime = Math.pow(2, retryCount) * 1000;
      console.log(`Retrying chunk ${index} after ${backoffTime}ms`);
      await sleep(backoffTime);
      return transcribeChunkWithRetry(chunkBuffer, index, retryCount + 1);
    }
    return { success: false, error: error.message, index };
  }
}

async function getAudioFileSize(audioPath) {
  const stats = await fs.stat(audioPath);
  return stats.size;
}

async function getAudioChunk(audioPath, start, end) {
  // Add minimum chunk size verification
  const chunkSize = end - start;
  console.log(
    `Attempting to read chunk: start=${start}, end=${end}, size=${chunkSize} bytes`
  );

  if (chunkSize < 4096) {
    // If chunk is too small, it might cause format issues
    console.log(`Chunk size ${chunkSize} bytes is too small, skipping...`);
    return null;
  }

  try {
    const chunks = [];
    const readStream = createReadStream(audioPath, { start, end: end - 1 });

    readStream.on("data", (chunk) => chunks.push(chunk));
    readStream.on("error", (err) => {
      console.error(`Error reading chunk ${start}-${end}: ${err.message}`);
      throw err;
    });

    return new Promise((resolve, reject) => {
      readStream.on("end", () => {
        const buffer = Buffer.concat(chunks);
        console.log(`Successfully read chunk: ${buffer.length} bytes`);
        resolve(buffer);
      });
      readStream.on("error", reject);
    });
  } catch (error) {
    console.error(`Exception in getAudioChunk: ${error.message}`);
    throw error;
  }
}

async function getObjectMetadata(bucket, key) {
  try {
    const response = await s3Client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );

    // Extract the x-amz-meta-* headers
    const metadata = {
      contentId: response.Metadata["contentid"],
      type: response.Metadata["type"],
      title: response.Metadata["title"],
      parentId: response.Metadata["parentid"],
      orderIndex: parseInt(response.Metadata["orderindex"]),
    };

    return metadata;
  } catch (error) {
    console.error("Error getting object metadata:", error);
    throw error;
  }
}

async function transcribeAudioInChunks(
  audioPath,
  chunkSize,
  concurrentRequests
) {
  // Replace the constants with parameters
  const CHUNK_SIZE = chunkSize;
  const CONCURRENT_REQUESTS = concurrentRequests;
  const getMemoryUsage = () => {
    const used = process.memoryUsage();
    return Math.round(used.heapUsed / 1024 / 1024);
  };

  console.log(`Initial memory usage: ${getMemoryUsage()}MB`);
  const fileSize = await getAudioFileSize(audioPath);
  let offset = 0;
  const chunks = [];

  // Prepare chunks
  while (offset < fileSize) {
    const endByte = Math.min(offset + CHUNK_SIZE, fileSize);
    chunks.push({ start: offset, end: endByte, index: chunks.length });
    offset = endByte;
  }

  const transcriptions = new Array(chunks.length);
  const failedChunks = [];

  // Process chunks in parallel batches
  for (let i = 0; i < chunks.length; i += CONCURRENT_REQUESTS) {
    const batchChunks = chunks.slice(i, i + CONCURRENT_REQUESTS);
    console.log(
      `Processing batch ${
        Math.floor(i / CONCURRENT_REQUESTS) + 1
      }, memory usage: ${getMemoryUsage()}MB`
    );
    console.log(
      `Batch chunks: ${JSON.stringify(
        batchChunks.map((c) => ({ index: c.index, size: c.end - c.start }))
      )}`
    );

    const batchPromises = batchChunks.map(async ({ start, end, index }) => {
      const chunkBuffer = await getAudioChunk(audioPath, start, end);
      if (!chunkBuffer) return null;
      return transcribeChunkWithRetry(chunkBuffer, index);
    });

    const results = await Promise.allSettled(batchPromises);

    // Process results and identify failed chunks
    results.forEach((result, batchIndex) => {
      if (result.status === "fulfilled" && result.value?.success) {
        transcriptions[result.value.index] = result.value.text;
      } else if (result.value) {
        failedChunks.push(chunks[i + batchIndex]);
      }
    });

    // Clean up batch memory
    global.gc?.();
  }

  // If we have failed chunks after all retries
  if (failedChunks.length > 0) {
    console.error(
      `Failed to process ${failedChunks.length} chunks after all retries`
    );
    throw new Error(
      "Transcription failed for some chunks after maximum retries"
    );
  }

  console.log(`Final memory usage: ${getMemoryUsage()}MB`);
  return transcriptions.filter(Boolean).join(" ");
}

const NOTIFICATION_TEMPLATES = {
  success: {
    topicArn: process.env.TOPIC_SNS_NOTIFICATION,
    subject: (fileName) =>
      `Tu archivo ${fileName.substring(0, 50)} ha sido completamente procesado`,
    message: (fileName) => `
        Hola,
        Tu archivo ${fileName} ha sido procesado exitosamente.
        Ya puedes revisar la transcripción
      `,
  },
  error: {
    topicArn: process.env.TOPIC_SNS_ERROR,
    subject: (fileName) => `Error processing: ${fileName.substring(0, 50)}...`,
    message: (fileName) => `
        Hola,
        Hubo un error al procesar tu archivo ${fileName} en la fase de transcripción.
        Tu administrador ya fue contactado y está revisando el problema.
      `,
  },
};

const notifyUploader = async (fileKey, isError = false) => {
  try {
    const fileName = fileKey.split(".")[0];
    const template = isError
      ? NOTIFICATION_TEMPLATES.error
      : NOTIFICATION_TEMPLATES.success;

    const params = {
      TopicArn: template.topicArn,
      Subject: template.subject(fileName),
      Message: template.message(fileName),
    };

    await snsClient.send(new PublishCommand(params));
    console.log(`SNS notification sent successfully for file: ${fileName}`);
  } catch (error) {
    console.error("Error sending SNS notification:", error);
    throw error;
  }
};

export const handler = async (event) => {
  try {
    for (const record of event.Records) {
      const s3Event = JSON.parse(record.body);
      const s3Data = s3Event.Records[0].s3;
      const bucketName = s3Data.bucket.name;
      const fileKey = s3Data.object.key;
      const outputBucketName = "lancemonos-nomas-transcripts";
      const sourceMetadata = await getObjectMetadata(bucketName, fileKey);
      const videoPath = `/tmp/${fileKey}`;
      const audioPath = `/tmp/${fileKey.split(".")[0]}.mp3`;

      console.log("Streaming video from S3...", fileKey);
      const { Body } = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: fileKey,
        })
      );

      await pipeline(Body, createWriteStream(videoPath));
      console.log("Video downloaded to:", videoPath);

      console.log("Extracting audio...");
      await new Promise((resolve, reject) => {
        let processedSize = 0;
        ffmpeg(videoPath)
          .toFormat("mp3")
          .outputOptions("-vn")
          .outputOptions("-ab", "64k")
          .on("start", (commandLine) => {
            console.log("FFmpeg command:", commandLine);
          })
          .on("progress", (progress) => {
            processedSize = progress.targetSize * 1024;
            console.log(`Processed ${processedSize / 1024 / 1024} MB`);
          })
          .on("error", reject)
          .on("end", resolve)
          .save(audioPath);
      });
      await fs.unlink(videoPath);
      console.log("Starting chunked transcription process...");
      const audioStats = await fs.stat(audioPath);
      const audioSizeMB = audioStats.size / 1024 / 1024;
      console.log(
        `Audio file size: ${audioSizeMB.toFixed(2)}MB from original video`
      );

      const { chunkSize, concurrentRequests } =
        getOptimizedChunkConfig(audioSizeMB);
      const fullTranscription = await transcribeAudioInChunks(
        audioPath,
        chunkSize,
        concurrentRequests
      );
      console.log("Full transcription completed");
      const fileExtension = fileKey.split(".").pop().toLowerCase();

      // Upload transcription result with metadata
      await s3Client.send(
        new PutObjectCommand({
          Bucket: outputBucketName,
          Key: `${fileKey.split(".")[0]}.json`,
          Body: JSON.stringify({
            transcription: fullTranscription,
          }),
          ContentType: "application/json",
          Metadata: {
            contentid: sourceMetadata.contentId,
            type: sourceMetadata.type,
            title: sourceMetadata.title,
            parentid: sourceMetadata.parentId,
            orderindex: sourceMetadata.orderIndex.toString(),
            fileExtension: fileExtension,
            originalObjectKey: fileKey,
          },
        })
      );

      await notifyUploader(fileKey);
      // Cleanup
      await fs.unlink(audioPath);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "All messages processed successfully",
      }),
    };
  } catch (error) {
    console.error("Error in handler:", error);
    // Send error notification before publishing to SNS error topic
    if (event.Records[0]) {
      const s3Event = JSON.parse(event.Records[0].body);
      const fileKey = s3Event.Records[0].s3.object.key;
      await notifyUploader(fileKey, true);
    }
    throw error;
  }
};
