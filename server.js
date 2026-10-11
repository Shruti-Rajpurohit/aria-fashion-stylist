const crypto = require('crypto');
const multer = require('multer');
const { Jimp } = require('jimp');
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

dotenv.config();

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  createdAt: { type: String },
  resetTokenHash: { type: String },
  resetTokenExpires: { type: Date },
  resetRequestedAt: { type: Date }
});

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function truncate(text, maxChars = 500) {
  if (!text) return text;
  return text.length > maxChars ? text.slice(0, maxChars) + '...' : text;
}

function friendlyError(err) {
  const m = String(err && (err.message || err));
  if (/rate limit|tokens per minute|429/i.test(m)) {
    return { status: 429, error: 'Aria is a bit busy. Give it a minute and try again.' };
  }
  return { status: 500, error: 'Something went wrong on my side. Please try again.' };
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

const User = mongoose.model('User', userSchema);
const Profile = mongoose.model('Profile', profileSchema);
const History = mongoose.model('History', historySchema);

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const API_BASE = (process.env.APP_BASE_URL || '').replace(/\/$/, '') || 'http://localhost:3000';

async function sendMail({ to, subject, html }) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'Aria', email: process.env.MAIL_FROM },
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  });
  if (!response.ok) throw new Error('Mail send failed: ' + response.status);
}

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
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64Image}` }
            }
          ]
        }],
        max_tokens: 400,
        temperature: 0.2
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
        max_tokens: 1200,
        temperature: 0.8,
        reasoning_effort: 'low'
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    if (data.choices?.[0]?.finish_reason === 'length') {
      console.warn('Groq completion ended due to max_tokens length cap');
    }
    return data.choices[0].message.content;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

function getAuthToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (typeof authHeader !== 'string') return null;

  const trimmed = authHeader.trim();
  if (!trimmed) return null;

  const bearerMatch = /^Bearer\s+(.+)$/i.exec(trimmed);
  return bearerMatch ? bearerMatch[1] : trimmed;
}

function verifyToken(req, res, next) {
  const token = getAuthToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

app.post('/api/signup', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
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
    const friendly = friendlyError(err);
    res.status(friendly.status).json({ error: friendly.error });
  }
});

app.post('/api/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
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
    const friendly = friendlyError(err);
    res.status(friendly.status).json({ error: friendly.error });
  }
});

app.post('/api/forgot-password', async (req, res) => {
  const generic = { success: true, message: 'If that email is registered, a reset link is on its way.' };
  const email = normalizeEmail(req.body.email);
  if (!email) {
    return res.json(generic);
  }
  try {
    const user = await User.findOne({ email });
    if (user && (!user.resetRequestedAt || Date.now() - user.resetRequestedAt.getTime() > 60000)) {
      const token = crypto.randomBytes(32).toString('hex');
      user.resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
      user.resetTokenExpires = new Date(Date.now() + 30 * 60 * 1000);
      user.resetRequestedAt = new Date();
      await user.save();
      const link = `${API_BASE}/reset.html?token=${token}`;
      await sendMail({
        to: user.email,
        subject: 'Reset your Aria password',
        html: `<p>Tap the link to choose a new password. It expires in 30 minutes.</p><p><a href="${link}">Reset password</a></p><p>Did not ask for this? Ignore this email.</p>`
      });
    }
  } catch (e) {
    console.error('Forgot password error:', e.message);
  }
  res.json(generic);
});

app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 8) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  try {
    const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const user = await User.findOne({ resetTokenHash: hash, resetTokenExpires: { $gt: new Date() } });
    if (!user) {
      return res.status(400).json({ error: 'This link is invalid or has expired' });
    }
    user.password = await bcrypt.hash(String(password), 10);
    user.resetTokenHash = undefined;
    user.resetTokenExpires = undefined;
    user.resetRequestedAt = undefined;
    await user.save();
    res.json({ success: true });
  } catch (err) {
    console.error('Reset password error:', err.message);
    const friendly = friendlyError(err);
    res.status(friendly.status).json({ error: friendly.error });
  }
});

app.get('/api/me', verifyToken, (req, res) => {
  res.json({ userId: req.userId });
});

app.post('/api/profile', verifyToken, async (req, res) => {
  const profile = req.body.profile;
  if (!profile) {
    return res.status(400).json({ error: 'Missing profile' });
  }
  try {
    const allowed = ['name','gender','ageGroup','bodyType','skinTone','height','preferredStyle',
      'favoriteColors','colorsToAvoid','budget','occasions','notes','photoAnalysis','avatar'];
    const update = {};
    for (const k of allowed) {
      if (profile[k] !== undefined) update[k] = String(profile[k]).slice(0, k === 'avatar' ? 3000000 : 800);
    }
    await Profile.findOneAndUpdate({ userId: req.userId }, { $set: update }, { upsert: true, new: true });
    res.json({ success: true });
  } catch (err) {
    console.error('Save profile error:', err.message);
    const friendly = friendlyError(err);
    res.status(friendly.status).json({ error: friendly.error });
  }
});

app.get('/api/profile/:userId', verifyToken, async (req, res) => {
  try {
    const profile = await Profile.findOne({ userId: req.userId });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json(profile);
  } catch (err) {
    console.error('Get profile error:', err.message);
    const friendly = friendlyError(err);
    res.status(friendly.status).json({ error: friendly.error });
  }
});

app.post('/api/history', verifyToken, async (req, res) => {
  const history = req.body.history || [];
  try {
    await History.findOneAndUpdate(
      { userId: req.userId },
      { userId: req.userId, history },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Save history error:', err.message);
    const friendly = friendlyError(err);
    res.status(friendly.status).json({ error: friendly.error });
  }
});

app.get('/api/history/:userId', verifyToken, async (req, res) => {
  try {
    const record = await History.findOne({ userId: req.userId });
    res.json({ history: record ? record.history : [] });
  } catch (err) {
    console.error('Get history error:', err.message);
    const friendly = friendlyError(err);
    res.status(friendly.status).json({ error: friendly.error });
  }
});

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
    const friendly = friendlyError(error);
    return res.status(502).json({ error: 'IMAGE_READ_FAILED' });
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
    return res.status(502).json({ error: 'IMAGE_READ_FAILED' });
  }
});

app.post('/api/chat', verifyToken, async (req, res) => {
  const { message, history, imageAnalysis } = req.body;

  try {
    const profile = await Profile.findOne({ userId: req.userId });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const systemPrompt = `You are Aria, a personal stylist with taste and a point of view. You talk like a sharp, warm friend who knows fashion inside out.

Client
- Name: ${profile.name} | ${profile.gender}, ${profile.ageGroup}
- Body: ${profile.bodyType}, ${profile.height} | Skin tone: ${profile.skinTone}
- Style: ${profile.preferredStyle}
- Likes: ${profile.favoriteColors} (a starting point, not a cage) | Avoid: ${profile.colorsToAvoid} (never use)
- Budget: ${profile.budget} | Occasions: ${profile.occasions}
- Notes: ${profile.notes || 'None'}
- Appearance: ${profile.photoAnalysis || 'Not provided'}

Personality
- Have opinions and state them. Say "I'd pick X over Y" and give one reason. Skip "it depends" unless you say what it depends on.
- Disagree kindly when something will not work for the client. Never flatter to be nice.
- Drop a small stylist aside now and then: a pet peeve, a trick, a trend you love or can't stand. One line.
- Warm and a bit playful, never gushing. At most one emoji per reply, often none. No sign-off line.

Conversation
- Answer first, in 2 to 4 short sentences, unless a full outfit was requested. A quick question gets a quick reply.
- End with at most one specific follow-up question when it moves things forward (occasion, weather, which of two options). Skip it when the answer is complete.
- Full outfit: top, bottom, footwear, accessories, hair in a compact list plus one line on why it works. Under 150 words.
- If asked for a verdict on a piece or photo, lead with the verdict (yes, no, yes with changes), then the reason.

Rules
- Only describe an image if an [Image analysis] block is present in the message. If the client mentions a photo and there is no analysis, say you could not see it and ask them to resend. Never invent clothing details.
- No tables, no headers. Only **bold** and simple "- " lists.
- Respect the budget and the avoid-colors list.`;

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
          ? `[Image analysis] ${truncate(imageAnalysis, 500)}\n\n${message || ''}`
          : message
      }
    ];

    const response = await chatWithGroq(messages);
    res.json({ response });
  } catch (error) {
    console.error('Chat error:', error.message);
    const friendly = friendlyError(error);
    res.status(friendly.status).json({ error: friendly.error });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Fashion AI server running on port ${PORT}`);
});
