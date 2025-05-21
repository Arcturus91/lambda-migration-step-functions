import { getObjectMetadata } from "./lib/s3-utils.js";

export const handler = async (event) => {
  console.log(
    "Initialize function received event:",
    JSON.stringify(event, null, 2)
  );

  try {
    // Check if the event is from SQS
    if (event.Records && event.Records[0]?.eventSource === "aws:sqs") {
      const sqsRecord = event.Records[0];
      const s3Event = JSON.parse(sqsRecord.body);

      // Process the S3 event
      const s3Record = s3Event.Records[0];
      const bucketName = s3Record.s3.bucket.name;
      const fileKey = s3Record.s3.object.key;

      console.log(`Processing file ${fileKey} from bucket ${bucketName}`);

      // Get metadata from the S3 object
      const metadata = await getObjectMetadata(bucketName, fileKey);

      // Prepare the execution context that will be passed through the state machine
      const executionContext = {
        fileKey,
        sourceBucket: bucketName,
        outputBucket: "lancemonos-nomas-transcripts",
        tempPath: `/tmp/${fileKey.split("/").pop()}`,
        audioPath: `/tmp/${fileKey.split("/").pop().split(".")[0]}.mp3`,
        metadata,
        fileExtension: fileKey.split(".").pop().toLowerCase(),
        timestamp: new Date().toISOString(),
      };

      console.log(
        "Created execution context:",
        JSON.stringify(executionContext, null, 2)
      );

      return executionContext;
    }
    // Direct invocation from Step Functions
    else if (event.fileKey) {
      // Already has context, just return it
      return event;
    }
    // Direct S3 event
    else if (event.Records && event.Records[0]?.eventSource === "aws:s3") {
      const s3Record = event.Records[0];
      const bucketName = s3Record.s3.bucket.name;
      const fileKey = s3Record.s3.object.key;

      console.log(`Processing file ${fileKey} from bucket ${bucketName}`);

      // Get metadata from the S3 object
      const metadata = await getObjectMetadata(bucketName, fileKey);

      // Prepare the execution context that will be passed through the state machine
      const executionContext = {
        fileKey,
        sourceBucket: bucketName,
        outputBucket: "lancemonos-nomas-transcripts",
        tempPath: `/tmp/${fileKey.split("/").pop()}`,
        audioPath: `/tmp/${fileKey.split("/").pop().split(".")[0]}.mp3`,
        metadata,
        fileExtension: fileKey.split(".").pop().toLowerCase(),
        timestamp: new Date().toISOString(),
      };

      console.log(
        "Created execution context:",
        JSON.stringify(executionContext, null, 2)
      );

      return executionContext;
    }

    // If we get here, it's an unsupported event type
    throw new Error("Unsupported event type");
  } catch (error) {
    console.error("Error in initialize function:", error);
    throw error;
  }
};
