import { notifyUser } from "../../lib/notification-utils.js";

export const handler = async (event) => {
  console.log(
    "Notify function received event:",
    JSON.stringify(event, null, 2)
  );

  try {
    const { fileKey, isError = false, error } = event;

    if (!fileKey) {
      throw new Error("Missing required parameter: fileKey");
    }

    // Extract a meaningful error message if there is an error
    let errorMessage = null;
    if (isError && error) {
      if (typeof error === "string") {
        errorMessage = error;
      } else if (error.message) {
        errorMessage = error.message;
      } else {
        errorMessage = JSON.stringify(error);
      }
    }

    // Send notification
    console.log(
      `Sending ${isError ? "error" : "success"} notification for ${fileKey}`
    );
    await notifyUser(fileKey, isError, errorMessage);

    console.log("Notification sent successfully");

    // Return the result
    return {
      ...event,
      notificationSent: true,
      notificationSentAt: new Date().toISOString(),
      notificationType: isError ? "error" : "success",
    };
  } catch (error) {
    console.error("Error in notify function:", error);
    throw error;
  }
};
