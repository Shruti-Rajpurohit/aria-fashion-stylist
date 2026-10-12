const API_BASE = window.location.origin;
const token = localStorage.getItem('aria_token');
const userId = localStorage.getItem('aria_userId');
const userName = localStorage.getItem('aria_name');

if (!token || !userId) {
  window.location.href = 'login.html';
}

let chatHistory = [];
let selectedChatImage = null;
let selectedChatImageName = '';
let activeChatId = null;
let chatList = [];
let currentChatFull = false;
let currentChatNudge = false;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatRelativeTime(dateValue) {
  if (!dateValue) return 'just now';
  const diffMs = Date.now() - new Date(dateValue).getTime();
  const diffMins = Math.max(1, Math.round(diffMs / 60000));
  if (diffMins < 60) return diffMins + 'm ago';
  const diffHours = Math.round(diffMins / 60);
  if (diffHours < 24) return diffHours + 'h ago';
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 7) return diffDays + 'd ago';
  const d = new Date(dateValue);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatMessage(text) {
  const lines = escapeHtml(text || '').split('\n');
  let out = '', inList = false;
  for (const line of lines) {
    const m = /^- (.*)$/.exec(line);
    if (m) {
      if (!inList) { out += '<ul>'; inList = true; }
      out += '<li>' + m[1] + '</li>';
    } else {
      if (inList) { out += '</ul>'; inList = false; }
      out += line + '<br>';
    }
  }
  if (inList) out += '</ul>';
  return out.replace(/(<br>)+$/, '')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');
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

function renderChatList() {
  const containers = [document.getElementById('chatList'), document.getElementById('drawerChatList')];
  containers.forEach(container => {
    if (!container) return;
    container.innerHTML = '';

    chatList.forEach(chat => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'chat-item' + (chat.chatId === activeChatId ? ' active' : '');
      item.dataset.chatId = chat.chatId;
      item.innerHTML = `
        <span class="chat-item-title">${escapeHtml(chat.title || 'New chat')}</span>
        <span class="chat-item-meta">${formatRelativeTime(chat.updatedAt)}</span>
      `;
      item.addEventListener('click', () => loadChat(chat.chatId));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'chat-item-delete';
      deleteBtn.textContent = '×';
      deleteBtn.setAttribute('aria-label', 'Delete chat');
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteChat(chat.chatId);
      });

      item.appendChild(deleteBtn);
      container.appendChild(item);
    });
  });
}

function updateChatBanner() {
  const banner = document.getElementById('chatBanner');
  if (!banner) return;

  if (currentChatFull || currentChatNudge) {
    banner.hidden = false;
    banner.classList.add('visible');
    banner.querySelector('.chat-banner-text').textContent = currentChatFull
      ? 'This chat is getting long. Start a new chat for the best advice'
      : 'This chat is getting long. Start a new chat for the best advice';
    const action = banner.querySelector('.chat-banner-action');
    action.style.display = 'inline-flex';
    banner.classList.toggle('full', currentChatFull);
  } else {
    banner.hidden = true;
    banner.classList.remove('visible');
  }
}

function setInputState() {
  const input = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const isLocked = currentChatFull || !activeChatId;
  if (input) input.disabled = isLocked;
  if (sendBtn) sendBtn.disabled = isLocked;
}

function renderChatMessages() {
  const messages = document.getElementById('messages');
  if (!messages) return;

  messages.innerHTML = '';

  if (!chatHistory.length) {
    const welcome = document.createElement('div');
    welcome.className = 'welcome-card';
    welcome.innerHTML = '<div class="welcome-emoji">✨</div><p>Tell me what you need — an outfit for a special occasion, everyday look, date night, anything at all.</p>';
    messages.appendChild(welcome);
    return;
  }

  chatHistory.forEach(item => {
    addMessage(item.text, item.role === 'model' ? 'aria' : 'user');
  });
}

async function createNewChat() {
  try {
    const res = await fetch(API_BASE + '/api/chats', {
      method: 'POST',
      headers: { 'Authorization': token }
    });
    const data = await res.json();
    if (!res.ok || !data.chat) {
      throw new Error(data.error || 'Could not create a new chat');
    }
    const chat = data.chat;
    chatList = [chat, ...chatList];
    activeChatId = chat.chatId;
    chatHistory = [];
    currentChatFull = false;
    currentChatNudge = false;
    renderChatList();
    renderChatMessages();
    setInputState();
    updateChatBanner();
    toggleChatDrawer(false);
  } catch (err) {
    console.error('Create chat failed:', err);
    addMessage('Could not create a new chat. Please try again.', 'aria');
  }
}

async function loadChat(chatId) {
  if (!chatId) return;
  activeChatId = chatId;
  const res = await fetch(API_BASE + `/api/chats/${chatId}`, {
    headers: { 'Authorization': token }
  });
  const data = await res.json();
  if (!res.ok || !data.chat) {
    console.error(data.error || 'Could not open chat');
    return;
  }

  chatHistory = (data.chat.messages || []).map(msg => ({ role: msg.role, text: msg.text }));
  const replyCount = chatHistory.filter(m => m.role === 'model').length;
  currentChatFull = replyCount >= 8;
  currentChatNudge = replyCount >= 5;
  renderChatList();
  renderChatMessages();
  setInputState();
  updateChatBanner();
  toggleChatDrawer(false);
}

async function loadChats() {
  try {
    const res = await fetch(API_BASE + '/api/chats', {
      headers: { 'Authorization': token }
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Could not load chats');
    }

    chatList = data.chats || [];
    if (!chatList.length) {
      await createNewChat();
      return;
    }

    activeChatId = chatList[0].chatId;
    renderChatList();
    await loadChat(activeChatId);
  } catch (err) {
    console.error('Failed to load chats:', err);
  }
}

async function deleteChat(chatId) {
  if (!chatId) return;
  const confirmed = window.confirm('Delete this chat?');
  if (!confirmed) return;

  try {
    const res = await fetch(API_BASE + `/api/chats/${chatId}`, {
      method: 'DELETE',
      headers: { 'Authorization': token }
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Delete failed');
    }

    chatList = chatList.filter(chat => chat.chatId !== chatId);
    if (activeChatId === chatId) {
      if (chatList.length) {
        activeChatId = chatList[0].chatId;
        await loadChat(activeChatId);
      } else {
        activeChatId = null;
        chatHistory = [];
        currentChatFull = false;
        currentChatNudge = false;
        renderChatList();
        renderChatMessages();
        setInputState();
        updateChatBanner();
      }
    } else {
      renderChatList();
    }
  } catch (err) {
    console.error('Delete chat failed:', err);
    addMessage('Could not delete that chat. Please try again.', 'aria');
  }
}

function toggleChatDrawer(forceOpen) {
  const drawer = document.getElementById('chatDrawer');
  if (!drawer) return;
  const next = typeof forceOpen === 'boolean' ? forceOpen : !drawer.classList.contains('open');
  drawer.classList.toggle('open', next);
}

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
  const sendBtn = document.getElementById('sendBtn');
  const messagesEl = document.getElementById('messages');
  const message = input.value.trim();
  const imageFile = selectedChatImage;
  if (!message && !imageFile) return;
  if (!activeChatId) {
    await createNewChat();
    if (!activeChatId) return;
  }
  if (currentChatFull) return;

  input.disabled = true;
  sendBtn.disabled = true;

  const bubble = document.createElement('div');
  bubble.classList.add('message', 'user');
  if (imageFile) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(imageFile);
    img.style.cssText = 'max-width:100%; border-radius:10px; display:block; margin-bottom:6px;';
    bubble.appendChild(img);
  }
  if (message) {
    const textDiv = document.createElement('div');
    textDiv.innerHTML = formatMessage(message);
    bubble.appendChild(textDiv);
  }
  messagesEl.appendChild(bubble);

  const typingDiv = document.createElement('div');
  typingDiv.classList.add('message', 'aria');
  typingDiv.id = 'typingIndicator';
  typingDiv.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div><div class="typing-text">Aria is styling you...</div>';
  messagesEl.appendChild(typingDiv);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    let imageAnalysis = null;

    if (imageFile) {
      let imgData = null;
      try {
        const fd = new FormData();
        fd.append('image', imageFile);
        const imgRes = await fetch(API_BASE + '/api/analyze-chat-image', {
          method: 'POST',
          headers: { 'Authorization': token },
          body: fd
        });
        const parsed = await imgRes.json();
        if (imgRes.ok && parsed.success) imgData = parsed;
      } catch (err) {
        console.error('Image analysis failed:', err);
      }
      if (!imgData) {
        bubble.remove();
        typingDiv.remove();
        addMessage("I couldn't read that image, please try again", 'aria');
        return;
      }
      imageAnalysis = imgData.analysis;
    }

    input.value = '';
    input.style.height = 'auto';
    if (imageFile) removeSelectedImage();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const res = await fetch(API_BASE + '/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token
      },
      body: JSON.stringify({
        chatId: activeChatId,
        message: message || 'I shared a reference image above.',
        imageAnalysis
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const data = await res.json();
    typingDiv.remove();

    if (data.response) {
      addMessage(data.response, 'aria');
      chatHistory.push({ role: 'user', text: message || '[shared an image]' });
      chatHistory.push({ role: 'model', text: data.response });
      currentChatNudge = !!data.nudge;
      currentChatFull = !!data.full;
      updateChatBanner();
      setInputState();

      const matching = chatList.find(chat => chat.chatId === activeChatId);
      if (matching) {
        matching.title = matching.title && matching.title !== 'New chat' ? matching.title : (message || 'New chat').slice(0, 40);
        matching.updatedAt = new Date().toISOString();
        renderChatList();
      }
    } else if (data.error === 'CHAT_FULL') {
      currentChatFull = true;
      updateChatBanner();
      setInputState();
      addMessage('This chat is full. Start a new chat for the best advice.', 'aria');
    } else {
      addMessage(data.error || 'Something went wrong. Try again!', 'aria');
    }
  } catch (err) {
    typingDiv.remove();
    if (err.name === 'AbortError') {
      addMessage('Aria is taking too long. Please try again!', 'aria');
    } else {
      addMessage('Could not reach the server. Is it running?', 'aria');
      console.error(err);
    }
  } finally {
    input.disabled = false;
    sendBtn.disabled = false;
    setInputState();
    input.focus();
  }
}

function clearHistory() {
  if (!activeChatId) return;
  if (confirm('Delete this chat?')) {
    deleteChat(activeChatId);
  }
}

function handleLogout() {
  if (confirm('Are you sure you want to logout?')) {
    localStorage.clear();
    window.location.href = 'login.html';
  }
}

const savedThemeState = localStorage.getItem('aria_theme') || 'light';
document.documentElement.setAttribute('data-theme', savedThemeState);
const themeLabel = document.getElementById('themeLabel');
if (themeLabel) themeLabel.textContent = savedThemeState === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('aria_theme', next);
  const themeLabel = document.getElementById('themeLabel');
  if (themeLabel) themeLabel.textContent = next === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
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

function toggleSidebarCollapse() {
  const container = document.querySelector('.chat-container');
  const collapsed = container.classList.toggle('sidebar-collapsed');
  localStorage.setItem('aria_sidebar_collapsed', String(collapsed));
  const btn = document.getElementById('sidebarCollapseBtn');
  if (btn) btn.textContent = collapsed ? '⟩' : '⟨';
}

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

window.addEventListener('load', async () => {
  const profileRes = await fetch(API_BASE + '/api/profile/' + userId, {
    headers: { 'Authorization': token }
  });
  const profileData = await profileRes.json();

  if (profileData.error === 'Profile not found') {
    window.location.href = 'onboarding.html';
    return;
  }

  if (profileData.name) {
    localStorage.setItem('aria_name', profileData.name);
  }

  const displayName = profileData.name || userName || 'there';
  const sidebarName = document.getElementById('sidebarName');
  if (sidebarName) sidebarName.textContent = displayName;

  const sidebarTagline = document.getElementById('sidebarTagline');
  if (sidebarTagline) sidebarTagline.textContent = 'Hi ' + displayName + ', let\'s style you! 💫';

  const subtitleText = document.getElementById('subtitleText');
  if (subtitleText) subtitleText.textContent = 'Hi ' + displayName + ', let\'s style you! 💫';

  const avatarSource = profileData.avatar || localStorage.getItem('aria_avatar');
  if (avatarSource) {
    localStorage.setItem('aria_avatar', avatarSource);
    const headerAvatar = document.getElementById('headerAvatar');
    if (headerAvatar) {
      headerAvatar.innerHTML = '<img src="' + avatarSource + '" style="width:100%; height:100%; border-radius:50%; object-fit:cover;" />';
    }
    const sidebarAvatar = document.getElementById('sidebarAvatar');
    if (sidebarAvatar) {
      sidebarAvatar.innerHTML = '<img src="' + avatarSource + '" style="width:100%; height:100%; object-fit:cover;" />';
    }
  }

  const currentTheme = localStorage.getItem('aria_theme') || 'light';
  const sidebarThemeLabel = document.getElementById('sidebarThemeLabel');
  const sidebarThemeIcon = document.getElementById('sidebarThemeIcon');
  if (sidebarThemeLabel) sidebarThemeLabel.textContent = currentTheme === 'dark' ? 'Light Mode' : 'Dark Mode';
  if (sidebarThemeIcon) sidebarThemeIcon.textContent = currentTheme === 'dark' ? '☀️' : '🌙';

  const themeLabel = document.getElementById('themeLabel');
  if (themeLabel) themeLabel.textContent = currentTheme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';

  const sidebarCollapsedPref = localStorage.getItem('aria_sidebar_collapsed') === 'true';
  const container = document.querySelector('.chat-container');
  if (container && sidebarCollapsedPref) {
    container.classList.add('sidebar-collapsed');
    const btn = document.getElementById('sidebarCollapseBtn');
    if (btn) btn.textContent = '⟩';
  }

  document.getElementById('newChatBtn')?.addEventListener('click', createNewChat);
  document.getElementById('chatBannerAction')?.addEventListener('click', createNewChat);
  document.getElementById('sidebarCollapseBtn')?.addEventListener('click', toggleSidebarCollapse);
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
  document.getElementById('sendBtn').addEventListener('click', sendMessage);

  await loadChats();
  setInputState();
  updateChatBanner();
});
