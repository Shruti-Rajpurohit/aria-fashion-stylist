const token = localStorage.getItem('aria_token');
const userId = localStorage.getItem('aria_userId');
const userName = localStorage.getItem('aria_name');

if (!token || !userId) {
  window.location.href = 'login.html';
}

let chatHistory = [];
let selectedChatImage = null;
let selectedChatImageName = '';

function updateWelcomeMessage(text) {
  const el = document.getElementById('welcomeMsg');
  if (el) el.textContent = text;
}

function addMessage(text, sender) {
  const messages = document.getElementById('messages');
  const div = document.createElement('div');
  div.classList.add('message', sender);
  div.innerHTML = formatMessage(text);
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

function formatMessage(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>')
    .replace(/^- (.*?)(<br>|$)/gm, '<li>$1</li>')
    .replace(/(<li>.*?<\/li>)+/gs, '<ul>$&</ul>');
}

window.addEventListener('load', async () => {
  document.getElementById('userInput').disabled = true;
  document.getElementById('sendBtn').disabled = true;

  try {
    const [historyRes, profileRes] = await Promise.all([
      fetch(`https://aria-fashion-stylist-production.up.railway.app/api/history/${userId}`, {
        headers: { 'Authorization': token }
      }),
      fetch(`https://aria-fashion-stylist-production.up.railway.app/api/profile/${userId}`, {
        headers: { 'Authorization': token }
      })
    ]);

    const historyData = await historyRes.json();
    const profileData = await profileRes.json();

    if (profileData.error === 'Profile not found') {
      window.location.href = 'onboarding.html';
      return;
    }

    if (profileData.name) {
      localStorage.setItem('aria_name', profileData.name);
    }

    const displayName = profileData.name || userName || 'there';
    // Set correct theme label
    const themeLabel = document.getElementById('themeLabel');
    if (themeLabel) {
      const currentTheme = localStorage.getItem('aria_theme') || 'light';
      themeLabel.textContent = currentTheme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
    }

    // Show profile photo if available
    // Load avatar from profile first, fallback to localStorage
    const avatarSource = profileData.avatar || localStorage.getItem('aria_avatar');
    if (avatarSource) {
      localStorage.setItem('aria_avatar', avatarSource);
      const headerAvatar = document.getElementById('headerAvatar');
      if (headerAvatar) {
        headerAvatar.innerHTML = `<img src="${avatarSource}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;" />`;
      }
    }
    
    // Sync sidebar on desktop
    const sidebarAvatar = document.getElementById('sidebarAvatar');
    if (sidebarAvatar) {
      if (avatarSource) {
        sidebarAvatar.innerHTML = `<img src="${avatarSource}" style="width:100%; height:100%; object-fit:cover;" />`;
      }
    }
    const sidebarName = document.getElementById('sidebarName');
    if (sidebarName) sidebarName.textContent = displayName;

    const sidebarTagline = document.getElementById('sidebarTagline');
    if (sidebarTagline) sidebarTagline.textContent = `Hi ${displayName}, let's style you! 💫`;

    // Sync sidebar theme label
    const sidebarThemeLabel = document.getElementById('sidebarThemeLabel');
    const sidebarThemeIcon = document.getElementById('sidebarThemeIcon');
    const currentTheme = localStorage.getItem('aria_theme') || 'light';
    if (sidebarThemeLabel) sidebarThemeLabel.textContent = currentTheme === 'dark' ? 'Light Mode' : 'Dark Mode';
    if (sidebarThemeIcon) sidebarThemeIcon.textContent = currentTheme === 'dark' ? '☀️' : '🌙';

    document.getElementById('subtitleText').textContent = `Hi ${displayName}, let's style you! 💫`;

    chatHistory = historyData.history || [];

    if (chatHistory.length > 0) {
      document.getElementById('welcomeMsg')?.remove();
      chatHistory.forEach(item => {
        addMessage(item.text, item.role === 'model' ? 'aria' : 'user');
      });
      document.getElementById('userInput').disabled = false;
      document.getElementById('sendBtn').disabled = false;
    } else {
      setTimeout(() => {
        const welcomeEl = document.getElementById('welcomeMsg');
        if (welcomeEl) {
          const p = welcomeEl.querySelector('p');
          if (p) {
            p.textContent = `Hey ${displayName}! 👋 I'm Aria, your personal stylist. Tell me what you need — an outfit for a special occasion, everyday look, date night, anything at all. I've already got your profile so my suggestions will be just for you! ✨`;
          }
        }
        document.getElementById('userInput').disabled = false;
        document.getElementById('sendBtn').disabled = false;
      }, 800);
    }

  } catch (err) {
    console.error('Could not load data', err);
    window.location.href = 'onboarding.html';
  }
});

function handleChatImageSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  selectedChatImage = file;
  selectedChatImageName = file.name;

  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('chipPreviewImg').src = e.target.result;
    document.getElementById('chipFileName').textContent = file.name;
    document.getElementById('imagePreviewChip').style.display = 'flex';
  };
  reader.readAsDataURL(file);
}

function removeSelectedImage() {
  selectedChatImage = null;
  selectedChatImageName = '';
  document.getElementById('imagePreviewChip').style.display = 'none';
  document.getElementById('chatImageInput').value = '';
}

async function sendMessage() {
  const input = document.getElementById('userInput');
  const message = input.value.trim();
  if (!message && !selectedChatImage) return;

  input.value = '';
  input.style.height = 'auto';
  input.disabled = true;
  document.getElementById('sendBtn').disabled = true;

  // Show message in chat
  if (selectedChatImage) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const imgMsg = document.createElement('div');
      imgMsg.classList.add('message', 'user');
      imgMsg.innerHTML = `<img src="${e.target.result}" style="max-width:100%; border-radius:10px; display:block; margin-bottom:6px;" />${message ? `<div>${formatMessage(message)}</div>` : ''}`;
      document.getElementById('messages').appendChild(imgMsg);
      document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
    };
    reader.readAsDataURL(selectedChatImage);
  } else {
    addMessage(message, 'user');
  }

  // Show typing indicator
  const typingDiv = document.createElement('div');
  typingDiv.classList.add('message', 'aria');
  typingDiv.id = 'typingIndicator';
  typingDiv.innerHTML = `
    <div class="typing-dots">
      <span></span><span></span><span></span>
    </div>
    <div class="typing-text">Aria is styling you...</div>
  `;
  document.getElementById('messages').appendChild(typingDiv);
  document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;

  try {
    let imageAnalysis = null;

    if (selectedChatImage) {
      try {
        const imgFormData = new FormData();
        imgFormData.append('image', selectedChatImage);

        const imgRes = await fetch('https://aria-fashion-stylist-production.up.railway.app/api/analyze-chat-image', {
          method: 'POST',
          headers: { 'Authorization': token },
          body: imgFormData
        });

        const imgData = await imgRes.json();
        if (imgData.success) {
          imageAnalysis = imgData.analysis;
        }
      } catch (err) {
        console.error('Image analysis failed:', err);
      }

      removeSelectedImage();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const res = await fetch('https://aria-fashion-stylist-production.up.railway.app/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token
      },
      body: JSON.stringify({
        userId,
        message: message || 'I shared a reference image above.',
        history: chatHistory,
        imageAnalysis
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const data = await res.json();
    document.getElementById('typingIndicator')?.remove();

    if (data.response) {
      addMessage(data.response, 'aria');
      chatHistory.push({ role: 'user', text: message || '[shared an image]' });
      chatHistory.push({ role: 'model', text: data.response });

      fetch('https://aria-fashion-stylist-production.up.railway.app/api/history', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token
        },
        body: JSON.stringify({ userId, history: chatHistory })
      });
    } else {
      addMessage('Something went wrong. Try again!', 'aria');
    }

  } catch (err) {
    document.getElementById('typingIndicator')?.remove();
    if (err.name === 'AbortError') {
      addMessage('Aria is taking too long. Please try again!', 'aria');
    } else {
      addMessage('Could not reach the server. Is it running?', 'aria');
      console.error(err);
    }
  } finally {
    input.disabled = false;
    document.getElementById('sendBtn').disabled = false;
    input.focus();
  }
}

document.getElementById('sendBtn').addEventListener('click', sendMessage);

document.getElementById('userInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

document.getElementById('userInput').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = this.scrollHeight + 'px';
});

function clearHistory() {
  if (confirm('Start a fresh conversation with Aria?')) {
    chatHistory = [];
    document.getElementById('messages').innerHTML = '';
    addMessage(`Hey ${userName}! 👋 Fresh start! What would you like to style today? ✨`, 'aria');

    fetch('https://aria-fashion-stylist-production.up.railway.app/api/history', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token
      },
      body: JSON.stringify({ userId, history: [] })
    });
  }
}

function handleLogout() {
  if (confirm('Are you sure you want to logout?')) {
    localStorage.clear();
    window.location.href = 'login.html';
  }
}

// Theme toggle
const savedTheme = localStorage.getItem('aria_theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
const themeLabel = document.getElementById('themeLabel');
if (themeLabel) themeLabel.textContent = savedTheme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('aria_theme', next);
  // Mobile menu label
  const themeLabel = document.getElementById('themeLabel');
  if (themeLabel) themeLabel.textContent = next === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
  // Sidebar label
  const sidebarThemeLabel = document.getElementById('sidebarThemeLabel');
  const sidebarThemeIcon = document.getElementById('sidebarThemeIcon');
  if (sidebarThemeLabel) sidebarThemeLabel.textContent = next === 'dark' ? 'Light Mode' : 'Dark Mode';
  if (sidebarThemeIcon) sidebarThemeIcon.textContent = next === 'dark' ? '☀️' : '🌙';
}

function toggleMenu() {
  const menu = document.getElementById('chatMenu');
  const btn = document.getElementById('menuBtn');
  menu.classList.toggle('open');
  btn.classList.toggle('active');
}

// Close menu when clicking outside
document.addEventListener('click', (e) => {
  const menu = document.getElementById('chatMenu');
  const btn = document.getElementById('menuBtn');
  if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
    menu.classList.remove('open');
    btn.classList.remove('active');
  }
});

function clearHistoryFromMenu() {
  document.getElementById('chatMenu').classList.remove('open');
  document.getElementById('menuBtn').classList.remove('active');
  clearHistory();
}

function useChip(el) {
  const input = document.getElementById('userInput');
  input.value = el.textContent.replace(/[^\w\s]/gi, '').trim();
  input.focus();
  document.getElementById('suggestionChips').style.display = 'none';
}