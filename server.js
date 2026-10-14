const crypto = require('crypto');
const multer = require('multer');
const { Jimp } = require('jimp');
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const MAX_CHAT_IMAGES = 3;

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
if (!MONGODB_URI || !JWT_SECRET) {
  console.error('Missing MONGODB_URI or JWT_SECRET');
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
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

function approxTokens(text) {
  return Math.ceil((String(text || '').length || 0) / 4);
}

const clip = (t, n) => (t && t.length > n ? t.slice(0, n) + '...' : t);

function shapeStored(m) {
  if (m.role === 'model') return { role: 'assistant', content: clip(m.text, 1200) };
  let c = clip(m.text, 500);
  if (m.analysis) c += '\n\n[Image analysis] ' + clip(m.analysis, 500);
  return { role: 'user', content: c };
}

function buildMessages(systemPrompt, stored, userContent, budget = 4500) {
  const valid = (stored || []).filter(m => m && m.text && (m.role === 'user' || m.role === 'model'));
  const hist = valid.map(shapeStored);
  let used = approxTokens(systemPrompt) + approxTokens(userContent);
  const kept = [];
  let i = hist.length - 1;
  for (; i >= 0; i--) {
    const c = approxTokens(hist[i].content);
    if (used + c > budget) break;
    used += c;
    kept.unshift(hist[i]);
  }

  if (i >= 0) {
    const firstUser = valid.find(m => m.role === 'user');
    if (firstUser) kept.unshift({ role: 'user', content: '[Start of this chat] ' + clip(firstUser.text, 400) });
  }
  return [{ role: 'system', content: systemPrompt }, ...kept, { role: 'user', content: userContent }];
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

const chatSchema = new mongoose.Schema({
  chatId: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  title: { type: String, default: 'New chat' },
  messages: [{
    role: { type: String, enum: ['user', 'model'], required: true },
    text: { type: String, required: true },
    imageIds: [{ type: String }],
    ts: { type: Date, default: Date.now },
    analysis: { type: String }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Profile = mongoose.model('Profile', profileSchema);
const History = mongoose.model('History', historySchema);
const Chat = mongoose.model('Chat', chatSchema);

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';
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

async function prepareVisionImage(file) {
  try {
    const image = await Jimp.read(file.buffer);
    const scale = Math.min(1, 800 / Math.max(image.bitmap.width, image.bitmap.height));
    if (scale < 1) {
      image.resize({
        w: Math.round(image.bitmap.width * scale),
        h: Math.round(image.bitmap.height * scale)
      });
    }
    return {
      buffer: await image.getBuffer('image/jpeg', { quality: 75 }),
      mimeType: 'image/jpeg'
    };
  } catch (err) {
    console.log('Compression skipped:', err.message);
    return { buffer: file.buffer, mimeType: file.mimetype };
  }
}

async function analyzeImagesWithVision(files, prompt) {
  const images = await Promise.all(files.map(prepareVisionImage));
  const content = [{ type: 'text', text: prompt }];
  images.forEach((image, index) => {
    content.push(
      { type: 'text', text: `Image ${index + 1}` },
      {
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${image.buffer.toString('base64')}` }
      }
    );
  });

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
        messages: [{ role: 'user', content }],
        max_tokens: 800,
        reasoning_effort: 'none',
        temperature: 0.2
      }),
      signal: controller.signal
    });

    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (response.ok) throw error;
      data = {};
    }
    if (!response.ok || data.error) {
      const error = new Error(data.error?.message || `Vision request failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const analysis = data.choices?.[0]?.message?.content;
    if (typeof analysis !== 'string' || !analysis.trim()) {
      throw new Error('Vision response was empty');
    }
    return analysis;
  } finally {
    clearTimeout(timeoutId);
  }
}

const chatImagePrompt = `For each image, describe in under 70 words what it shows: a garment, footwear, hairstyle, accessory, or person. Include visible colors, fit, pattern, and overall vibe. If one image shows a person and another shows a garment, say so plainly. Reply as plain text with one "Image 1:", "Image 2:", etc. label per image.`;

function imageAnalysisError(res, error) {
  console.error('Vision error:', error.message);
  const requestTooLarge = error.status === 413 || /request too large/i.test(error.message);
  if (requestTooLarge || error.status === 429 || /rate.?limit|tokens per minute|429/i.test(error.message)) {
    return res.status(requestTooLarge ? 413 : 429).json({
      error: 'IMAGE_READ_FAILED',
      message: 'That is a lot of photos at once. Try fewer.'
    });
  }
  return res.status(502).json({ error: 'IMAGE_READ_FAILED' });
}

function receiveChatImages(req, res, next) {
  upload.array('images', MAX_CHAT_IMAGES)(req, res, error => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_UNEXPECTED_FILE'
        ? `Choose no more than ${MAX_CHAT_IMAGES} images.`
        : 'Each image must be 10 MB or less.';
      return res.status(400).json({ error: 'IMAGE_UPLOAD_FAILED', message });
    }
    return next(error);
  });
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
    const analysis = await analyzeImagesWithVision([req.file], prompt);
    res.json({ success: true, analysis });
  } catch (error) {
    return imageAnalysisError(res, error);
  }
});

app.post('/api/analyze-chat-images', verifyToken, receiveChatImages, async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No images uploaded' });
  try {
    const analysis = await analyzeImagesWithVision(req.files, chatImagePrompt);
    res.json({ success: true, analysis });
  } catch (error) {
    return imageAnalysisError(res, error);
  }
});

app.post('/api/analyze-chat-image', verifyToken, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  try {
    const analysis = await analyzeImagesWithVision([req.file], chatImagePrompt);
    res.json({ success: true, analysis });
  } catch (error) {
    return imageAnalysisError(res, error);
  }
});

app.get('/api/chats', verifyToken, async (req, res) => {
  try {
    let chats = await Chat.find({ userId: req.userId }).sort({ updatedAt: -1 }).select('chatId title updatedAt createdAt');
    if (!chats.length) {
      const legacy = await History.findOne({ userId: req.userId });
      if (legacy && Array.isArray(legacy.history) && legacy.history.length) {
        const migrated = await Chat.create({
          chatId: `chat_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
          userId: req.userId,
          title: 'Earlier conversation',
          messages: legacy.history.map(msg => ({
            role: msg.role === 'model' ? 'model' : 'user',
            text: String(msg.text || ''),
            ts: new Date()
          }))
        });
        chats = [migrated];
      }
    }
    res.json({ chats });
  } catch (err) {
    console.error('List chats error:', err.message);
    const friendly = friendlyError(err);
    res.status(friendly.status).json({ error: friendly.error });
  }
});

app.post('/api/chats', verifyToken, async (req, res) => {
  try {
    const chatId = `chat_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const chat = await Chat.create({
      chatId,
      userId: req.userId,
      title: 'New chat',
      messages: []
    });
    res.status(201).json({ chat });
  } catch (err) {
    console.error('Create chat error:', err.message);
    const friendly = friendlyError(err);
    res.status(friendly.status).json({ error: friendly.error });
  }
});

app.get('/api/chats/:chatId', verifyToken, async (req, res) => {
  try {
    const chat = await Chat.findOne({ chatId: req.params.chatId, userId: req.userId });
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    res.json({ chat });
  } catch (err) {
    console.error('Get chat error:', err.message);
    const friendly = friendlyError(err);
    res.status(friendly.status).json({ error: friendly.error });
  }
});

app.delete('/api/chats/:chatId', verifyToken, async (req, res) => {
  try {
    const deleted = await Chat.findOneAndDelete({ chatId: req.params.chatId, userId: req.userId });
    if (!deleted) return res.status(404).json({ error: 'Chat not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete chat error:', err.message);
    const friendly = friendlyError(err);
    res.status(friendly.status).json({ error: friendly.error });
  }
});

app.post('/api/chat', verifyToken, async (req, res) => {
  const { chatId, message, imageAnalysis } = req.body;

  try {
    const profile = await Profile.findOne({ userId: req.userId });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const NUDGE_AT = 5;
    const MAX_REPLIES = 8;

    let chat = await Chat.findOne({ chatId, userId: req.userId });
    if (!chat) {
      chat = await Chat.create({
        chatId: chatId || `chat_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
        userId: req.userId,
        title: 'New chat',
        messages: []
      });
    }

    const replies = (chat.messages || []).filter(m => m.role === 'model').length;
    if (replies >= MAX_REPLIES) {
      return res.status(409).json({ error: 'CHAT_FULL' });
    }

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
- End with at most one specific follow-up question when it moves things forward (weather, which of two options, a missing detail). Never ask about anything already said in this chat. Skip it when the answer is complete.
- Full outfit: top, bottom, footwear, accessories, hair in a compact list plus one line on why it works. Under 150 words.
- If asked for a verdict on a piece or photo, lead with the verdict (yes, no, yes with changes), then the reason.

Memory and focus
- Everything said earlier in this chat is known: the occasion, the pieces under discussion, and any correction. Never ask for it again.
- The profile occasions are only defaults. If the chat names an occasion, such as an evening Indian wedding function, it overrides them, and every suggestion must fit it, including traditional wear, fabrics and colors.
- If the client corrects you about an image, their word is final. Redo your judgment with the correction and stay on the same outfit.
- When comparing images, call them Image 1, Image 2, Image 3 and stay on those pieces unless asked for alternatives.
- You know Indian and South Asian occasion wear as well as Western fashion.

Rules
- Only describe an image if an [Image analysis] block is present in the message. If the client mentions a photo and there is no analysis, say you could not see it and ask them to resend. Never invent clothing details.
- No tables, no headers. Only **bold** and simple "- " lists.
- Respect the budget and the avoid-colors list.`;

    const stored = (chat.messages || []).map(m => ({ role: m.role, text: m.text, analysis: m.analysis }));
    const cleanMessage = message || 'I shared a reference image above.';
    const userContent = imageAnalysis
      ? `${cleanMessage}\n\n[Image analysis] ${truncate(imageAnalysis, 1500)}`
      : cleanMessage;

    const messages = buildMessages(systemPrompt, stored, userContent, 4500);
    const response = await chatWithGroq(messages);

    const nextReplies = replies + 1;
    const userMsg = {
      role: 'user',
      text: cleanMessage,
      analysis: imageAnalysis ? truncate(imageAnalysis, 600) : undefined,
      ts: new Date()
    };
    const modelMsg = { role: 'model', text: response, ts: new Date() };

    chat.messages.push(userMsg, modelMsg);
    if (!chat.title || chat.title === 'New chat') {
      chat.title = cleanMessage.replace(/\s+/g, ' ').trim().slice(0, 40) || 'New chat';
    }
    
    chat.updatedAt = new Date();
    await chat.save();

    res.json({ response, nudge: nextReplies >= NUDGE_AT, full: nextReplies >= MAX_REPLIES });
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
