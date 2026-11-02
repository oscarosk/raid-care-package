(() => {
  const title = document.querySelector('#pack-title');
  const target = document.querySelector('#pack-target');
  const countdown = document.querySelector('#countdown');
  const itemCount = document.querySelector('#item-count');
  const status = document.querySelector('#pack-status');
  const recentItems = document.querySelector('#recent-items');
  let endsAt = 0;
  let total = 0;
  let socket;
  let retryTimer;

  function renderMessage(container, item) {
    const text = String(item.text ?? '');
    const emotes = Array.isArray(item.emotes) ? item.emotes : [];
    let cursor = 0;
    for (const emote of emotes) {
      const begin = Number(emote.begin);
      const end = Number(emote.end);
      if (!emote.id || begin < cursor || end <= begin || begin > text.length) continue;
      container.append(document.createTextNode(text.slice(cursor, begin)));
      const image = document.createElement('img');
      image.src = `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(emote.id)}/default/dark/2.0`;
      image.alt = String(emote.name ?? 'Twitch emote');
      image.loading = 'eager';
      container.append(image);
      cursor = end;
    }
    container.append(document.createTextNode(text.slice(cursor)));
  }

  function addItem(item) {
    const card = document.createElement('article');
    card.className = 'pack-item';
    const avatar = document.createElement('span');
    avatar.className = 'avatar-mark';
    avatar.textContent = String(item.user ?? '?').slice(0, 1).toUpperCase();
    const copy = document.createElement('div');
    copy.className = 'item-copy';
    const user = document.createElement('strong');
    user.className = 'item-user';
    user.textContent = String(item.user ?? 'viewer');
    const message = document.createElement('span');
    message.className = 'item-message';
    renderMessage(message, item);
    copy.append(user, message);
    card.append(avatar, copy);
    recentItems.prepend(card);
    while (recentItems.children.length > 4) recentItems.lastElementChild.remove();
  }

  function handle(message) {
    if (message.kind === 'pack_started') {
      endsAt = Number(message.endsAt);
      total = 0;
      recentItems.replaceChildren();
      itemCount.textContent = '0';
      title.textContent = 'A little love goes a long way';
      target.textContent = `Packing for ${message.target}`;
      status.innerHTML = 'Chat, add a note with <b>!pack your message</b>';
      return;
    }
    if (message.kind === 'pack_item') {
      total = Number(message.itemCount ?? total + 1);
      itemCount.textContent = String(total);
      addItem(message.item ?? {});
      return;
    }
    if (message.kind === 'pack_target_resolved') {
      target.textContent = `Packing for ${message.target}`;
      return;
    }
    if (message.kind === 'pack_ended') {
      endsAt = 0;
      status.textContent = 'Package packed — waiting for the raid';
    }
  }

  function connect() {
    clearTimeout(retryTimer);
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${scheme}//${location.host}/ws?view=pack`);
    socket.onmessage = event => {
      try { handle(JSON.parse(event.data)); } catch (error) { console.error('Invalid pack overlay message', error); }
    };
    socket.onclose = () => { retryTimer = setTimeout(connect, 1200); };
    socket.onerror = () => socket.close();
  }

  setInterval(() => {
    countdown.textContent = endsAt ? String(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))) : 'READY';
  }, 200);
  connect();
})();
