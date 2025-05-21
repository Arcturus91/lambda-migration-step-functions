import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const snsClient = new SNSClient({ region: "sa-east-1" });

const NOTIFICATION_TEMPLATES = {
  success: {
    topicArn:
      process.env.TOPIC_SNS_NOTIFICATION ||
      "arn:aws:sns:sa-east-1:905418161107:Notifications-in-lambdas-Lancemonos",
    subject: (fileName) =>
      `Tu archivo ${fileName.substring(0, 50)} ha sido completamente procesado`,
    message: (fileName) => `
      Hola,
      Tu archivo ${fileName} ha sido procesado exitosamente.
      Ya puedes revisar la transcripción
    `,
  },
  error: {
    topicArn:
      process.env.TOPIC_SNS_ERROR ||
      "arn:aws:sns:sa-east-1:905418161107:Errors-in-lambdas-Lancemonos",
    subject: (fileName) => `Error processing: ${fileName.substring(0, 50)}...`,
    message: (fileName, errorMessage) => `
      Hola,
      Hubo un error al procesar tu archivo ${fileName}.
      Error: ${errorMessage || "Error desconocido"}
      Tu administrador ya fue contactado y está revisando el problema.
    `,
  },
};

export async function notifyUser(
  fileKey,
  isError = false,
  errorMessage = null
) {
  try {
    const fileName = fileKey.split("/").pop().split(".")[0];
    const template = isError
      ? NOTIFICATION_TEMPLATES.error
      : NOTIFICATION_TEMPLATES.success;

    const params = {
      TopicArn: template.topicArn,
      Subject: template.subject(fileName),
      Message: isError
        ? template.message(fileName, errorMessage)
        : template.message(fileName),
    };

    await snsClient.send(new PublishCommand(params));
    console.log(`SNS notification sent successfully for file: ${fileName}`);
    return true;
  } catch (error) {
    console.error("Error sending SNS notification:", error);
    throw error;
  }
}
