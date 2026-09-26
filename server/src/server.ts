import express from "express";

const app = express();

const PORT = 3000;

app.use(express.json());

app.get("/api/v1/health", (_req, res) => {
  res.json({
    status: "OK",
    message: "Doctor booking api is running",
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
