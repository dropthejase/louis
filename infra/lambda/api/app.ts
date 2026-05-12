/**
 * Express application factory for the backend API.
 *
 * Mounts all route routers under their public path prefixes and configures
 * CORS (origin locked to FRONTEND_URL). Used by both the local dev server
 * (index.ts) and the Lambda handler (lambda.ts) via serverless-http.
 */
import express from "express";
import cors from "cors";
import { chatRouter } from "./routes/chat";
import { projectsRouter } from "./routes/projects";
import { documentsRouter } from "./routes/documents";
import { tabularRouter } from "./routes/tabular";
import { workflowsRouter } from "./routes/workflows";
import { userRouter } from "./routes/user";
import { downloadsRouter } from "./routes/downloads";

export const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    credentials: true,
  }),
);

app.use(express.json({ limit: "50mb" }));

app.use((req, _res, next) => {
  console.log(`[API] ${req.method} ${req.path}`, Object.keys(req.body ?? {}).length ? JSON.stringify(req.body) : '');
  next();
});

app.use("/chat", chatRouter);
app.use("/projects", projectsRouter);
app.use("/single-documents", documentsRouter);
app.use("/tabular-review", tabularRouter);
app.use("/workflows", workflowsRouter);
app.use("/user", userRouter);
app.use("/users", userRouter);
app.use("/download", downloadsRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`[API ERROR] ${req.method} ${req.path}`, err);
  res.status(500).json({ detail: err instanceof Error ? err.message : 'Internal server error' });
});
