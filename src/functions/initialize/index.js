import { getObjectMetadata } from "./lib/s3-utils.js";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

// Initialize the Step Functions client
const sfnClient = new SFNClient();

// Get the state machine ARN from environment variable
const stateMachineArn = process.env.STATE_MACHINE_ARN;

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

      // Start the Step Function execution
      const executionName = `video-processing-${fileKey
        .split("/")
        .pop()
        .replace(/\./g, "-")}-${Date.now()}`;

      const startExecutionCommand = new StartExecutionCommand({
        stateMachineArn: stateMachineArn,
        name: executionName,
        input: JSON.stringify(executionContext),
      });

      const response = await sfnClient.send(startExecutionCommand);

      console.log("Started Step Function execution:", response);

      return {
        statusCode: 200,
        executionArn: response.executionArn,
        executionStartDate: response.startDate,
        executionContext,
        message: "Step Function execution started successfully",
      };
    }
    // Direct invocation (for testing or direct calls)
    else if (event.fileKey) {
      // Already has context, start the execution
      const executionName = `video-processing-${event.fileKey
        .split("/")
        .pop()
        .replace(/\./g, "-")}-${Date.now()}`;

      const startExecutionCommand = new StartExecutionCommand({
        stateMachineArn: stateMachineArn,
        name: executionName,
        input: JSON.stringify(event),
      });

      const response = await sfnClient.send(startExecutionCommand);

      console.log("Started Step Function execution:", response);

      return {
        statusCode: 200,
        executionArn: response.executionArn,
        executionStartDate: response.startDate,
        executionContext: event,
        message: "Step Function execution started successfully",
      };
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

      // Start the Step Function execution
      const executionName = `video-processing-${fileKey
        .split("/")
        .pop()
        .replace(/\./g, "-")}-${Date.now()}`;

      const startExecutionCommand = new StartExecutionCommand({
        stateMachineArn: stateMachineArn,
        name: executionName,
        input: JSON.stringify(executionContext),
      });

      const response = await sfnClient.send(startExecutionCommand);

      console.log("Started Step Function execution:", response);

      return {
        statusCode: 200,
        executionArn: response.executionArn,
        executionStartDate: response.startDate,
        executionContext,
        message: "Step Function execution started successfully",
      };
    }

    // If we get here, it's an unsupported event type
    throw new Error("Unsupported event type");
  } catch (error) {
    console.error("Error in initialize function:", error);
    throw error;
  }
};
