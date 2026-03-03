const multer = require('multer');
const { Jimp } = require('jimp');
const express = require('express');
const { Mistral } = require('@mistralai/mistralai');
const dotenv = require('dotenv');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

dotenv.config();

const app = express();
const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PROFILES_FILE = 'profiles.json';
const USERS_FILE = 'users.json';
const HISTORIES_FILE = 'histories.json';
const JWT_SECRET = process.env.JWT_SECRET;

// Groq vision setup
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_VISION_MODEL = 'meta-llama/llama-4-maverick-17b-128e-instruct';

// Multer setup - store in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images allowed'));
    }
  }
});

// Analyze image with Groq Vision
async function analyzeImageWithVision(imageBuffer, mimeType, prompt) {
  try {
    const image = await Jimp.read(imageBuffer);
    image.resize({ w: 800 });
    imageBuffer = await image.getBuffer('image/jpeg', { quality: 75 });
    mimeType = 'image/jpeg';
  } catch (err) {
    console.log('Compression skipped:', err.message);
  }

  const base64Image = imageBuffer.toString('base64');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`
                }
              }
            ]
          }
        ],
        max_tokens: 500
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices[0].message.content;

  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

function loadProfiles() {
  if (!fs.existsSync(PROFILES_FILE)) fs.writeFileSync(PROFILES_FILE, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(PROFILES_FILE));
}
function saveProfiles(profiles) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
}
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(USERS_FILE));
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function loadHistories() {
  if (!fs.existsSync(HISTORIES_FILE)) fs.writeFileSync(HISTORIES_FILE, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(HISTORIES_FILE));
}
function saveHistories(histories) {
  fs.writeFileSync(HISTORIES_FILE, JSON.stringify(histories, null, 2));
}

function verifyToken(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  const users = loadUsers();
  if (users[email]) {
    return res.status(400).json({ error: 'Email already registered' });
  }
  const hashedPassword = await bcrypt.hash(password, 10);
  const userId = 'user_' + Date.now();
  users[email] = {
    userId,
    email,
    password: hashedPassword,
    createdAt: new Date().toISOString()
  };
  saveUsers(users);
  const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, token, userId, hasProfile: false });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  const users = loadUsers();
  const user = users[email];
  if (!user) {
    return res.status(400).json({ error: 'Invalid email or password' });
  }
  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) {
    return res.status(400).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ userId: user.userId, email }, JWT_SECRET, { expiresIn: '30d' });
  const profiles = loadProfiles();
  const hasProfile = !!profiles[user.userId];
  res.json({ success: true, token, userId: user.userId, hasProfile });
});

app.get('/api/me', verifyToken, (req, res) => {
  res.json({ userId: req.userId });
});

app.post('/api/profile', verifyToken, (req, res) => {
  const { userId, profile } = req.body;
  if (!userId || !profile) return res.status(400).json({ error: 'Missing userId or profile' });
  const profiles = loadProfiles();
  profiles[userId] = profile;
  saveProfiles(profiles);
  res.json({ success: true });
});

app.get('/api/profile/:userId', verifyToken, (req, res) => {
  const profiles = loadProfiles();
  const profile = profiles[req.params.userId];
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json(profile);
});

app.post('/api/history', verifyToken, (req, res) => {
  const { userId, history } = req.body;
  const histories = loadHistories();
  histories[userId] = history;
  saveHistories(histories);
  res.json({ success: true });
});

app.get('/api/history/:userId', verifyToken, (req, res) => {
  const histories = loadHistories();
  res.json({ history: histories[req.params.userId] || [] });
});

// Analyze profile photo
app.post('/api/analyze-profile-photo', verifyToken, upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }
  try {
    const prompt = `You are a fashion stylist assistant. Analyze this person's photo and describe:
1. Apparent skin tone (e.g. fair, light, medium, olive, tan, deep/dark)
2. Hair color and texture (e.g. black straight, brown wavy, blonde curly)
3. Eye color if visible
4. Face shape if determinable
5. Any other features relevant to fashion and styling

Be concise and factual. This description will be used to give personalized fashion advice.`;

    const analysis = await analyzeImageWithVision(req.file.buffer, req.file.mimetype, prompt);
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Vision error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Analyze chat reference image
app.post('/api/analyze-chat-image', verifyToken, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }
  try {
    const prompt = `You are a fashion stylist assistant. Analyze this image and describe in detail:
1. If it shows clothing/outfit: describe the garments, style, fit, colors, patterns
2. If it shows footwear: describe the type, style, color, heel height if applicable
3. If it shows a hairstyle: describe the cut, length, texture, color, styling
4. If it shows accessories: describe each item
5. Overall aesthetic/vibe (e.g. casual, formal, bohemian, streetwear, elegant)
6. Season/occasion it seems appropriate for

Be specific and detailed. This will help a stylist suggest similar or complementary items.`;

    const analysis = await analyzeImageWithVision(req.file.buffer, req.file.mimetype, prompt);
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Vision error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat', verifyToken, async (req, res) => {
  const { userId, message, history, imageAnalysis } = req.body;
  const profiles = loadProfiles();
  const profile = profiles[userId];
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  const systemPrompt = `You are Aria, a warm, expert personal fashion stylist and trusted style companion. You genuinely care about helping people discover their best style — not just suggesting outfits, but understanding their lifestyle, personality, and goals.

Here is the profile of the person you are styling:
- Name: ${profile.name}
- Gender: ${profile.gender}
- Age Group: ${profile.ageGroup}
- Body Type: ${profile.bodyType}
- Skin Tone: ${profile.skinTone}
- Height: ${profile.height}
- Preferred Style: ${profile.preferredStyle}
- Favorite Colors: ${profile.favoriteColors} (use as preference reference, not strict rules — feel free to suggest complementary and contrasting colors that work well with these)
- Colors to Avoid: ${profile.colorsToAvoid} (strictly avoid these)
- Budget Range: ${profile.budget}
- Typical Occasions: ${profile.occasions}
- Additional Notes: ${profile.notes || 'None'}
- Physical Appearance from Photo: ${profile.photoAnalysis || 'Not provided'}

MOST IMPORTANT RULE — Read what the person is actually asking and respond appropriately:

- If they ask for a specific outfit for an occasion: give outfit + footwear + accessories + hairstyle in a clean structured way
- If they ask about overall style direction or wardrobe planning: think like a real stylist having a consultation — talk about their style identity, what pieces to invest in, what to avoid, how to build a versatile wardrobe. Be conversational, not formulaic.
- If they ask only about hair: just talk about hair in depth
- If they ask a question or want advice: have a real conversation, don't force a structured outfit breakdown
- If they share a reference image: analyze what you see and connect it meaningfully to their profile and question
- If they want styling tips or rules: give them genuinely useful fashion knowledge personalized to them

RESPONSE STYLE:
- Never use the same format every time — adapt to what they need
- Be like a knowledgeable friend who happens to be a stylist, not a template machine
- When suggesting colors, use their favorites as a foundation but expand thoughtfully — suggest what actually works for their skin tone and style, not just what they listed
- Keep responses focused and punchy — no unnecessary padding
- End with something warm and encouraging but keep it natural, not cheesy
- When suggesting specific outfit combinations, keep it realistic and within their budget`;

  try {
    const validHistory = (history || []).filter(h => h.text && h.text.trim() !== '' && (h.role === 'user' || h.role === 'model'));
    const messages = [
      { role: 'system', content: systemPrompt },
      ...validHistory.map(h => ({
        role: h.role === 'model' ? 'assistant' : 'user',
        content: h.text
      })),
      {
        role: 'user',
        content: imageAnalysis
          ? `[User shared a reference image. Image analysis: ${imageAnalysis}]\n\n${message}`
          : message
      }
    ];

    const result = await client.chat.complete({
      model: 'mistral-small-latest',
      messages: messages
    });

    const response = result.choices[0].message.content;
    res.json({ response });

  } catch (error) {
    console.error('ERROR:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Fashion AI server running on port ${PORT}`);
});
