import { OpenAI } from "openai";
import { promises as fs } from "fs";
import { createReadStream } from "fs";
import { File } from "buffer";
import { uploadDataToS3 } from "../../lib/s3-utils.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const handler = async (event) => {
  console.log(
    "Transcribe Chunks function received event:",
    JSON.stringify(event, null, 2)
  );

  try {
    const {
      audioPath,
      fileKey,
      outputBucket,
      metadata,
      chunkConfig,
      fileExtension,
    } = event;

    if (!audioPath || !fileKey || !outputBucket || !chunkConfig) {
      throw new Error("Missing required parameters");
    }

    // Extract audio chunks and transcribe
    console.log("Starting chunked transcription process...");
    const fullTranscription = await transcribeAudioInChunks(
      audioPath,
      chunkConfig.chunkSize,
      chunkConfig.concurrentRequests
    );

    console.log("Transcription completed, preparing to upload results");

    // Prepare transcription metadata
    const transcriptionData = {
      transcription: fullTranscription,
      metadata: {
        original_file: fileKey,
        processed_at: new Date().toISOString(),
      },
    };

    // Build metadata for S3 upload
    const s3Metadata = {
      contentid: metadata.contentId || "",
      type: metadata.type || "",
      title: metadata.title || "",
      parentid: metadata.parentId || "",
      orderindex: (metadata.orderIndex || 0).toString(),
      fileextension: fileExtension,
      originalobjectkey: fileKey,
    };

    // Upload transcription to S3
    const outputKey = `${fileKey.split(".")[0]}.json`;
    await uploadDataToS3(
      outputBucket,
      outputKey,
      transcriptionData,
      "application/json",
      s3Metadata
    );

    console.log(`Transcription uploaded to ${outputBucket}/${outputKey}`);

    // Clean up
    await fs.unlink(audioPath);
    console.log(`Deleted audio file: ${audioPath}`);

    // Return the updated context
    return {
      ...event,
      transcriptionCompleted: true,
      transcriptionCompletedAt: new Date().toISOString(),
      transcription: fullTranscription,
      outputKey,
    };
  } catch (error) {
    console.error("Error in transcribe-chunks function:", error);
    throw error;
  }
};

async function getAudioFileSize(audioPath) {
  const stats = await fs.stat(audioPath);
  return stats.size;
}

async function getAudioChunk(audioPath, start, end) {
  // Add minimum chunk size verification
  const chunkSize = end - start;
  if (chunkSize < 4096) {
    // If chunk is too small, it might cause format issues
    console.log(`Chunk size ${chunkSize} bytes is too small, skipping...`);
    return null;
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    const readStream = createReadStream(audioPath, { start, end: end - 1 });

    readStream.on("data", (chunk) => chunks.push(chunk));
    readStream.on("error", reject);
    readStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function transcribeChunkWithRetry(chunkBuffer, index, retryCount = 0) {
  try {
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

    return { success: true, text: transcription.text, index };
  } catch (error) {
    if (retryCount < MAX_RETRIES) {
      const backoffTime = Math.pow(2, retryCount) * 1000;
      console.log(`Retrying chunk ${index} after ${backoffTime}ms`);
      await sleep(backoffTime);
      return transcribeChunkWithRetry(chunkBuffer, index, retryCount + 1);
    }
    return { success: false, error, index };
  }
}

async function transcribeAudioInChunks(
  audioPath,
  chunkSize,
  concurrentRequests
) {
  // Track memory usage
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
    const endByte = Math.min(offset + chunkSize, fileSize);
    chunks.push({ start: offset, end: endByte, index: chunks.length });
    offset = endByte;
  }

  const transcriptions = new Array(chunks.length);
  const failedChunks = [];

  // Process chunks in parallel batches
  for (let i = 0; i < chunks.length; i += concurrentRequests) {
    const batchChunks = chunks.slice(i, i + concurrentRequests);
    console.log(
      `Processing batch ${
        Math.floor(i / concurrentRequests) + 1
      }, memory usage: ${getMemoryUsage()}MB`
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
