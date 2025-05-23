import ffmpeg from "fluent-ffmpeg";
import { promises as fs } from "fs";
import { downloadFileFromS3, uploadFileToS3 } from "./lib/s3-utils.js";

// Set the ffmpeg path to the Lambda layer locations
const ffmpegPath = "/opt/bin/ffmpeg";
ffmpeg.setFfmpegPath(ffmpegPath);

export const handler = async (event) => {
  console.log(
    "Download & Extract function received event:",
    JSON.stringify(event, null, 2)
  );

  try {
    // Extract required parameters
    const { fileKey, sourceBucket, tempPath, audioPath, audioBucket } = event;

    // Validate required parameters
    if (!fileKey || !sourceBucket || !tempPath || !audioPath || !audioBucket) {
      throw new Error(
        "Missing required parameters: fileKey, sourceBucket, tempPath, audioPath, or audioBucket"
      );
    }

    console.log(
      `Processing video ${fileKey} from ${sourceBucket} to audio in ${audioBucket}`
    );

    // Step 1: Download the video file from S3
    console.log(`Downloading video ${fileKey} from ${sourceBucket} to ${tempPath}`);
    await downloadFileFromS3(sourceBucket, fileKey, tempPath);
    console.log(`Successfully downloaded video to ${tempPath}`);

    // Step 2: Extract audio from video
    console.log(`Extracting audio from ${tempPath} to ${audioPath}`);
    await extractAudio(tempPath, audioPath);

    // Get audio file size
    const audioStats = await fs.stat(audioPath);
    const audioSizeMB = audioStats.size / 1024 / 1024;
    console.log(`Audio file size: ${audioSizeMB.toFixed(2)}MB from original video`);

    // Step 3: Upload the audio file to the target bucket
    const audioKey = `${fileKey.split('.')[0]}.mp3`;
    await uploadFileToS3(
      audioBucket,
      audioKey,
      audioPath,
      "audio/mp3",
      { sourceVideo: fileKey }
    );
    console.log(`Successfully uploaded audio to ${audioBucket}/${audioKey}`);

    // Step 4: Clean up the original video file to save space
    await fs.unlink(tempPath);
    console.log(`Deleted original video file: ${tempPath}`);

    // Calculate optimal chunk size based on the audio size
    const chunkConfig = getOptimizedChunkConfig(audioSizeMB);

    // Return the updated context
    return {
      ...event,
      videoDownloaded: true,
      videoDownloadedAt: new Date().toISOString(),
      audioExtracted: true,
      audioExtractedAt: new Date().toISOString(),
      audioSizeMB,
      audioKey,
      chunkConfig,
    };
  } catch (error) {
    console.error("Error in download-extract function:", error);
    throw error;
  }
};

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

  console.log(`Optimized config for ${audioSizeInMB}MB audio:`, {
    chunkSizeMB: Math.round(optimalConfig.chunkSize / 1024 / 1024),
    concurrentRequests: optimalConfig.concurrentRequests,
    estimatedChunks: Math.ceil(
      (audioSizeInMB * 1024 * 1024) / optimalConfig.chunkSize
    ),
  });

  return optimalConfig;
}

function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
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
}