import { downloadFileFromS3 } from "./lib/s3-utils.js";

export const handler = async (event) => {
  console.log(
    "Download Video function received event:",
    JSON.stringify(event, null, 2)
  );

  try {
    const { fileKey, sourceBucket, tempPath } = event;

    if (!fileKey || !sourceBucket || !tempPath) {
      throw new Error(
        "Missing required parameters: fileKey, sourceBucket, or tempPath"
      );
    }

    console.log(
      `Downloading video ${fileKey} from ${sourceBucket} to ${tempPath}`
    );

    // Download the video file from S3
    await downloadFileFromS3(sourceBucket, fileKey, tempPath);

    console.log(`Successfully downloaded video to ${tempPath}`);

    // Return the updated context
    return {
      ...event,
      videoDownloaded: true,
      videoDownloadedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error("Error in download-video function:", error);
    throw error;
  }
};
