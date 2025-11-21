import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { OpenAI } from "openai";
import { randomUUID } from "crypto";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// In-memory storage for demo (replace with real database later)
const users = new Map();     // username -> { passwordHash, stats }
const reviews = [];          // { username, rating, text, createdAt }

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

// ===== Auth helpers =====

function createToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [type, token] = authHeader.split(" ");
  if (type !== "Bearer" || !token) {
    return res.status(401).json({ message: "Missing or invalid Authorization header" });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { username: payload.username };
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
}

// ===== AUTH ROUTES =====

app.post("/api/signup", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: "Username and password are required" });
  }

  if (users.has(username)) {
    return res.status(400).json({ message: "Username already exists" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  users.set(username, {
    passwordHash,
    stats: { totalPlayed: 0, totalWins: 0, totalDraws: 0, totalLosses: 0 }
  });

  const token = createToken(username);
  res.json({
    token,
    user: { username }
  });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: "Username and password are required" });
  }

  const user = users.get(username);
  if (!user) {
    return res.status(400).json({ message: "User not found" });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(400).json({ message: "Incorrect password" });
  }

  const token = createToken(username);
  res.json({ token, user: { username } });
});

// Placeholder Google routes (optional)
app.get("/auth/google/start", (req, res) => {
  res.status(501).json({ message: "Google OAuth not implemented in this demo" });
});

app.get("/auth/google/callback", (req, res) => {
  res.status(501).json({ message: "Google OAuth callback not implemented in this demo" });
});

// ===== QUIZ GENERATION WITH OPENAI =====

async function generateQuizJSON(difficulty) {
  const quizId = randomUUID();

  const systemPrompt = `
You are an expert cricket quiz maker and commentator.
You generate high-quality multiple-choice cricket quizzes with 10 questions each.
Levels: easy, medium, hard, custom.
Use JSON only. Provide exciting short commentary lines.
`.trim();

  const userPrompt = `
Generate a ten-question cricket quiz for difficulty: "${difficulty}".
Return only JSON. Use quizId "${quizId}".
Each question must have: text, 4 options, correctIndex, commentary(intro/correct/wrong).
`.trim();

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });

  const content = response.output[0].content[0].text;
  let quiz;

  try {
    quiz = JSON.parse(content);
  } catch (err) {
    console.error("Failed to parse quiz JSON:", err, content);
    throw new Error("AI returned invalid quiz data");
  }

  quiz.quizId = quiz.quizId || quizId;

  // Normalise questions, ensure 4 options
  quiz.questions = (quiz.questions || []).map((q, idx) => {
    q.id = q.id || "q" + (idx + 1);
    if (!Array.isArray(q.options)) q.options = [];
    while (q.options.length < 4) q.options.push("Option " + (q.options.length + 1));
    q.options = q.options.slice(0, 4);
    if (typeof q.correctIndex !== "number" || q.correctIndex < 0 || q.correctIndex > 3) {
      q.correctIndex = 0;
    }
    return q;
  });

  return quiz;
}

app.get("/api/quiz", authMiddleware, async (req, res) => {
  const difficulty = req.query.difficulty || "medium";

  try {
    const quiz = await generateQuizJSON(difficulty);
    res.json(quiz);
  } catch (err) {
    res.status(500).json({ message: "Failed to generate quiz: " + err.message });
  }
});

// Receive result and update stats
app.post("/api/quiz/result", authMiddleware, (req, res) => {
  const { quizId, score, totalQuestions } = req.body || {};
  const username = req.user.username;
  const user = users.get(username);
  if (!user) {
    return res.status(400).json({ message: "User not found" });
  }

  const s = user.stats;
  s.totalPlayed++;
  if (score >= 6) s.totalWins++;
  else if (score === 5) s.totalDraws++;
  else s.totalLosses++;

  res.json({ message: "Result recorded", stats: s });
});

// ===== RATINGS & REVIEWS =====

app.get("/api/reviews/summary", (req, res) => {
  if (!reviews.length) {
    return res.json({ averageRating: 0, totalRatings: 0, reviews: [] });
  }

  const totalRatings = reviews.length;
  const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
  const averageRating = sum / totalRatings;

  const recent = reviews
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10)
    .map(r => ({
      user: r.username,
      rating: r.rating,
      text: r.text
    }));

  res.json({ averageRating, totalRatings, reviews: recent });
});

app.post("/api/reviews", authMiddleware, (req, res) => {
  const { rating, text } = req.body || {};
  const username = req.user.username;

  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ message: "Rating must be between 1 and 5" });
  }

  reviews.push({
    username,
    rating,
    text: text || "",
    createdAt: new Date()
  });

  res.json({ message: "Review submitted" });
});

// ===== START SERVER =====

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log("Cricket quiz backend running on port", PORT);
});