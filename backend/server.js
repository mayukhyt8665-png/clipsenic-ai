import express from "express";
import cors from "cors";

const app = express();

app.use(cors({
  origin: "https://clipsenic-ai.vercel.app"
}));

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    name: "ClipSenic AI Backend",
    status: "running",
    message: "Backend connected successfully!"
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ClipSenic backend running on port ${PORT}`);
});
