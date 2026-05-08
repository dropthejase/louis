/**
 * Local development entry point for the backend API.
 *
 * Starts an HTTP server on PORT (default 3001). Not used in the Lambda
 * deployment — use lambda.ts for that. Loads .env via dotenv/config.
 */
import "dotenv/config";
import { app } from "./app";

const PORT = process.env.PORT ?? 3001;

app.listen(PORT, () => {
  console.log(`Mike backend running on port ${PORT}`);
});
