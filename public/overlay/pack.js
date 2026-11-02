(() => {
  const stage = document.querySelector('.pack-stage');
  const title = document.querySelector('#pack-title');
  const target = document.querySelector('#pack-target');
  const countdown = document.querySelector('#countdown');
  const itemCount = document.querySelector('#item-count');
  const itemCountLabel = document.querySelector('#item-count-label');
  const status = document.querySelector('#pack-status');
  const recentItems = document.querySelector('#recent-items');
  const giftBox = document.querySelector('.gift-box-pack');
  const giftLandings = document.querySelector('#gift-landings');
  let endsAt = 0;
  let total = 0;
  let socket;
  let retryTimer;
  let sealedTimer;
  let boxPopTimer;
  let retryDelay = 1000;

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
    landGift(String(item.user ?? 'viewer'));
    itemCount.classList.remove('count-pop');
    void itemCount.offsetWidth;
    itemCount.classList.add('count-pop');
  }

  function landGift(user) {
    const landing = document.createElement('span');
    landing.className = 'landing-gift';
    landing.setAttribute('aria-hidden', 'true');
    const crate = document.createElement('span');
    crate.className = 'landing-crate';
    const sender = document.createElement('strong');
    sender.textContent = user;
    landing.append(crate, sender);
    giftLandings.append(landing);
    landing.addEventListener('animationend', () => landing.remove(), { once: true });

    giftBox.classList.remove('is-pop');
    void giftBox.offsetWidth;
    giftBox.classList.add('is-pop');
    clearTimeout(boxPopTimer);
    boxPopTimer = setTimeout(() => giftBox.classList.remove('is-pop'), 450);
  }

  function handle(message) {
    if (message.kind === 'pack_started') {
      clearTimeout(sealedTimer);
      stage.classList.remove('is-sealed', 'is-closing');
      endsAt = Number(message.endsAt);
      total = 0;
      recentItems.replaceChildren();
      giftLandings.replaceChildren();
      giftBox.classList.remove('is-pop');
      clearTimeout(boxPopTimer);
      itemCount.textContent = '0';
      itemCountLabel.textContent = 'gifts packed';
      title.textContent = 'A little love goes a long way';
      target.textContent = `Packing for ${message.target}`;
      status.innerHTML = 'Chat, add a note with <b>!pack your message</b>';
      return true;
    }
    if (message.kind === 'pack_item') {
      total = Number(message.itemCount ?? total + 1);
      itemCount.textContent = String(total);
      itemCountLabel.textContent = total === 1 ? 'gift packed' : 'gifts packed';
      addItem(message.item ?? {});
      return true;
    }
    if (message.kind === 'pack_target_resolved') {
      target.textContent = `Packing for ${message.target}`;
      return true;
    }
    if (message.kind === 'pack_ended') {
      endsAt = 0;
      stage.classList.remove('is-closing');
      stage.classList.add('is-sealed');
      status.textContent = `Package sealed, heading to ${String(message.target ?? target.textContent.replace(/^Packing for /, ''))}!`;
      clearTimeout(sealedTimer);
      sealedTimer = setTimeout(() => {
        stage.classList.remove('is-sealed');
        status.textContent = 'Package packed — waiting for the raid';
      }, 5000);
      return true;
    }
    return false;
  }

  function connect() {
    clearTimeout(retryTimer);
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${location.host}/ws?view=pack`;
    console.info(`[overlay:pack] connecting to ${url}`);
    socket = new WebSocket(url);
    socket.onopen = () => {
      retryDelay = 1000;
      console.info('[overlay:pack] connected');
    };
    socket.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        console.info(`[overlay:pack] received ${message.kind}`);
        if (handle(message) && message.deliveryId) {
          socket.send(JSON.stringify({ kind: 'overlay_ack', deliveryId: message.deliveryId }));
          console.info(`[overlay:pack] rendered ${message.kind}`);
        }
      } catch (error) { console.error('[overlay:pack] error handling server message', error); }
    };
    socket.onclose = event => {
      console.warn(`[overlay:pack] disconnected (${event.code}: ${event.reason || 'no reason'}); reconnecting in ${retryDelay}ms`);
      const delay = retryDelay;
      retryDelay = Math.min(15000, retryDelay * 2);
      retryTimer = setTimeout(connect, delay);
    };
    socket.onerror = () => socket.close();
  }

  setInterval(() => {
    const remaining = endsAt ? Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)) : 0;
    countdown.textContent = endsAt ? String(remaining) : 'READY';
    stage.classList.toggle('is-closing', Boolean(endsAt && remaining <= 10 && remaining > 0));
  }, 200);
  connect();
})();
