const multer = require('multer');
const { Jimp } = require('jimp');
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

dotenv.config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Define schemas
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  createdAt: { type: String }
});

function truncate(text, maxChars = 500) {
  if (!text) return text;
  return text.length > maxChars ? text.slice(0, maxChars) + '...' : text;
}

const profileSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  name: String,
  gender: String,
  ageGroup: String,
  bodyType: String,
  skinTone: String,
  height: String,
  preferredStyle: String,
  favoriteColors: String,
  colorsToAvoid: String,
  budget: String,
  occasions: String,
  notes: String,
  photoAnalysis: String,
  avatar: String
});

const historySchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  history: { type: Array, default: [] }
});

// Define models
const User = mongoose.model('User', userSchema);
const Profile = mongoose.model('Profile', profileSchema);
const History = mongoose.model('History', historySchema);

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET;

// Groq vision setup
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_VISION_MODEL = 'meta-llama/llama-4-maverick-17b-128e-instruct';

// Multer setup
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
              image_url: { url: `data:${mimeType};base64,${base64Image}` }
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

async function chatWithGroq(messages) {
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
        model: 'openai/gpt-oss-120b',
        messages,
        max_tokens: 700
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

// Auth routes
app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  try {
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = 'user_' + Date.now();
    await User.create({
      userId,
      email,
      password: hashedPassword,
      createdAt: new Date().toISOString()
    });
    const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, userId, hasProfile: false });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign({ userId: user.userId, email }, JWT_SECRET, { expiresIn: '30d' });
    const profile = await Profile.findOne({ userId: user.userId });
    res.json({ success: true, token, userId: user.userId, hasProfile: !!profile });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/me', verifyToken, (req, res) => {
  res.json({ userId: req.userId });
});

// Profile routes
app.post('/api/profile', verifyToken, async (req, res) => {
  const { userId, profile } = req.body;
  if (!userId || !profile) {
    return res.status(400).json({ error: 'Missing userId or profile' });
  }
  try {
    await Profile.findOneAndUpdate(
      { userId },
      { userId, ...profile },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Save profile error:', err.message);
    res.status(500).json({ error: 'Failed to save profile' });
  }
});

app.get('/api/profile/:userId', verifyToken, async (req, res) => {
  try {
    const profile = await Profile.findOne({ userId: req.params.userId });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json(profile);
  } catch (err) {
    console.error('Get profile error:', err.message);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// History routes
app.post('/api/history', verifyToken, async (req, res) => {
  const { userId, history } = req.body;
  try {
    await History.findOneAndUpdate(
      { userId },
      { userId, history },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Save history error:', err.message);
    res.status(500).json({ error: 'Failed to save history' });
  }
});

app.get('/api/history/:userId', verifyToken, async (req, res) => {
  try {
    const record = await History.findOne({ userId: req.params.userId });
    res.json({ history: record ? record.history : [] });
  } catch (err) {
    console.error('Get history error:', err.message);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// Vision routes
app.post('/api/analyze-profile-photo', verifyToken, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
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

app.post('/api/analyze-chat-image', verifyToken, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
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

// Chat route
app.post('/api/chat', verifyToken, async (req, res) => {
  const { userId, message, history, imageAnalysis } = req.body;

  try {
    const profile = await Profile.findOne({ userId });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const systemPrompt = `You are Aria, a warm, expert personal fashion stylist who genuinely cares about helping people discover their style, not just outfits.

Client profile:
- Name: ${profile.name}, ${profile.gender}, ${profile.ageGroup}
- Body type: ${profile.bodyType}, Skin tone: ${profile.skinTone}, Height: ${profile.height}
- Style: ${profile.preferredStyle}
- Favorite colors: ${profile.favoriteColors} (a starting point, not a rule — suggest complementary and contrasting colors too)
- Colors to avoid: ${profile.colorsToAvoid} (strict)
- Budget: ${profile.budget}
- Occasions: ${profile.occasions}
- Notes: ${profile.notes || 'None'}
- Appearance: ${profile.photoAnalysis || 'Not provided'}

Match response to the ask:
- Specific outfit request: outfit + footwear + accessories + hair, structured
- Style direction or wardrobe planning: consultative and conversational, talk identity and what's worth investing in
- Hair-only question: just hair, in depth
- General question or advice: real conversation, no forced structure
- Reference image shared: connect what you see to their profile and question

Style: adapt format to the ask, never the same template twice. Talk like a stylist friend, not a script. Match length to the question — a quick question gets a quick answer, only go long when an outfit breakdown or real explanation calls for it. No padding. Warm sign-off, not cheesy. Keep suggestions realistic and within budget.`;

    const validHistory = (history || [])
      .filter(h => h.text && h.text.trim() !== '' && (h.role === 'user' || h.role === 'model'))
      .slice(-8);
    
    const messages = [
      { role: 'system', content: systemPrompt },
      ...validHistory.map(h => ({
        role: h.role === 'model' ? 'assistant' : 'user',
        content: truncate(h.text)
      })),
      {
        role: 'user',
        content: imageAnalysis
          ? `[User shared a reference image. Image analysis: ${truncate(imageAnalysis, 500)}]\n\n${message}`
          : message
      }
    ];

    const response = await chatWithGroq(messages);
    res.json({ response });

  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Fashion AI server running on port ${PORT}`);
});
