(() => {
  const stage = document.querySelector('.unbox-stage');
  const title = document.querySelector('#unbox-title');
  const subtitle = document.querySelector('#unbox-subtitle');
  const box = document.querySelector('#unbox-box');
  const revealList = document.querySelector('#reveal-list');
  const welcomeCard = document.querySelector('#welcome-card');
  const welcomeTitle = document.querySelector('#welcome-title');
  const welcomeDetail = document.querySelector('#welcome-detail');
  let socket;
  let retryTimer;
  let revealTimers = [];
  let welcomeTimer;
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
      container.append(image);
      cursor = end;
    }
    container.append(document.createTextNode(text.slice(cursor)));
  }

  function makeItem(item, index) {
    const card = document.createElement('article');
    card.className = 'reveal-item';
    card.style.animationDelay = `${Math.min(index * 70, 420)}ms`;
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
    return card;
  }

  function replayAnimation() {
    stage.classList.remove('is-playing', 'is-open', 'is-generic');
    box.style.animation = 'none';
    void box.offsetWidth;
    box.style.animation = '';
    stage.classList.add('is-playing');
  }

  function showArrival(message) {
    for (const timer of revealTimers) clearTimeout(timer);
    revealTimers = [];
    clearTimeout(welcomeTimer);
    revealList.replaceChildren();
    welcomeCard.hidden = true;
    replayAnimation();

    const raider = String(message.raider ?? 'A streamer');
    const viewers = Math.max(0, Number(message.viewers ?? 0));
    const items = Array.isArray(message.items) ? message.items : [];
    const hasPackage = Boolean(message.packageFound);
    stage.classList.toggle('is-generic', !hasPackage);
    title.textContent = hasPackage ? 'A gift from the other side' : 'A new community just arrived';
    subtitle.textContent = hasPackage ? `${raider} brought a little something` : `${raider} is bringing ${viewers.toLocaleString()} new friends`;

    revealTimers.push(setTimeout(() => stage.classList.add('is-open'), 1900));
    const revealStart = 2650;
    items.forEach((item, index) => {
      revealTimers.push(setTimeout(() => {
        revealList.append(makeItem(item, index));
        revealList.scrollTo({ top: revealList.scrollHeight, behavior: 'smooth' });
      }, revealStart + index * 3000));
    });
    const welcomeAt = revealStart + (hasPackage ? items.length * 3000 : 0) + 500;
    revealTimers.push(setTimeout(() => {
      welcomeTitle.textContent = `Welcome, ${raider}'s community!`;
      welcomeDetail.textContent = `${viewers.toLocaleString()} raiders · one big welcome`;
      welcomeCard.hidden = false;
      console.info('[overlay:unbox] welcome card shown');
      welcomeTimer = setTimeout(() => {
        welcomeCard.hidden = true;
        revealList.replaceChildren();
        stage.classList.remove('is-playing', 'is-open', 'is-generic');
        title.textContent = "Something's on the way";
        subtitle.textContent = 'Good things travel together.';
        console.info('[overlay:unbox] presentation cleared after 8 seconds');
      }, 8000);
    }, welcomeAt));
    console.info(`[overlay:unbox] rendering raid_arrival: package=${hasPackage}, items=${items.length}, raider=${raider}`);
    return true;
  }

  function connect() {
    clearTimeout(retryTimer);
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${location.host}/ws?view=unbox`;
    console.info(`[overlay:unbox] connecting to ${url}`);
    socket = new WebSocket(url);
    socket.onopen = () => {
      retryDelay = 1000;
      console.info('[overlay:unbox] connected');
    };
    socket.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        console.info(`[overlay:unbox] received ${message.kind}`);
        if (message.kind === 'raid_arrival' && showArrival(message) && message.deliveryId) {
          socket.send(JSON.stringify({ kind: 'overlay_ack', deliveryId: message.deliveryId }));
          console.info('[overlay:unbox] rendered raid_arrival');
        } else if (message.kind !== 'raid_arrival') {
          console.warn(`[overlay:unbox] ignored unexpected event ${message.kind}`);
        }
      } catch (error) { console.error('[overlay:unbox] error handling server message', error); }
    };
    socket.onclose = event => {
      console.warn(`[overlay:unbox] disconnected (${event.code}: ${event.reason || 'no reason'}); reconnecting in ${retryDelay}ms`);
      const delay = retryDelay;
      retryDelay = Math.min(15000, retryDelay * 2);
      retryTimer = setTimeout(connect, delay);
    };
    socket.onerror = () => socket.close();
  }

  connect();
})();
