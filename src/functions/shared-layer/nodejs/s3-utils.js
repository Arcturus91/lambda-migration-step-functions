import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { promises as fs } from "fs";

const s3Client = new S3Client({ region: "sa-east-1" });

export async function downloadFileFromS3(bucketName, fileKey, localPath) {
  console.log(`Downloading ${fileKey} from ${bucketName} to ${localPath}...`);

  try {
    const { Body } = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: fileKey,
      })
    );

    await pipeline(Body, createWriteStream(localPath));
    console.log(`Successfully downloaded ${fileKey} to ${localPath}`);
    return true;
  } catch (error) {
    console.error(`Error downloading file ${fileKey} from S3:`, error);
    throw error;
  }
}

export async function uploadFileToS3(
  bucketName,
  fileKey,
  filePath,
  contentType,
  metadata = {}
) {
  console.log(`Uploading ${filePath} to ${bucketName}/${fileKey}...`);

  try {
    const fileContent = await fs.readFile(filePath);

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: fileKey,
        Body: fileContent,
        ContentType: contentType,
        Metadata: metadata,
      })
    );

    console.log(`Successfully uploaded to ${bucketName}/${fileKey}`);
    return true;
  } catch (error) {
    console.error(`Error uploading file to S3:`, error);
    throw error;
  }
}

export async function uploadDataToS3(
  bucketName,
  fileKey,
  data,
  contentType,
  metadata = {}
) {
  console.log(`Uploading data to ${bucketName}/${fileKey}...`);

  try {
    const body = typeof data === "object" ? JSON.stringify(data) : data;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: fileKey,
        Body: body,
        ContentType: contentType,
        Metadata: metadata,
      })
    );

    console.log(`Successfully uploaded data to ${bucketName}/${fileKey}`);
    return true;
  } catch (error) {
    console.error(`Error uploading data to S3:`, error);
    throw error;
  }
}

export async function getObjectMetadata(bucket, key) {
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
      orderIndex: parseInt(response.Metadata["orderindex"] || "0"),
    };

    return metadata;
  } catch (error) {
    console.error("Error getting object metadata:", error);
    throw error;
  }
}