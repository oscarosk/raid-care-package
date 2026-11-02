(() => {
  const stage = document.querySelector('.unbox-stage');
  const title = document.querySelector('#unbox-title');
  const subtitle = document.querySelector('#unbox-subtitle');
  const box = document.querySelector('#unbox-box');
  const revealList = document.querySelector('#reveal-list');
  const finale = document.querySelector('#community-finale');
  const finaleTitle = document.querySelector('#finale-title');
  const finaleUsers = document.querySelector('#finale-users');
  const confettiField = document.querySelector('#confetti-field');
  const welcomeCard = document.querySelector('#welcome-card');
  const welcomeTitle = document.querySelector('#welcome-title');
  const welcomeDetail = document.querySelector('#welcome-detail');
  let socket;
  let retryTimer;
  let presentationTimers = [];
  let retryDelay = 1000;

  function clearPresentationTimers() {
    for (const timer of presentationTimers) clearTimeout(timer);
    presentationTimers = [];
  }

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
    card.style.animationDelay = `${Math.min(index * 45, 360)}ms`;
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

  function populateConfetti(items) {
    confettiField.replaceChildren();
    const emotes = items.flatMap(item => Array.isArray(item.emotes) ? item.emotes : [])
      .filter(emote => emote.id)
      .slice(0, 20);
    const count = emotes.length ? Math.max(20, emotes.length) : 32;
    const shapes = ['shape-dot', 'shape-diamond', 'shape-star', 'shape-ribbon'];
    for (let index = 0; index < count; index += 1) {
      const node = emotes.length ? document.createElement('img') : document.createElement('span');
      node.className = emotes.length ? 'confetti-piece confetti-emote' : `confetti-piece ${shapes[index % shapes.length]}`;
      if (emotes.length) {
        const emote = emotes[index % emotes.length];
        node.src = `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(emote.id)}/default/dark/2.0`;
        node.alt = '';
      }
      const x = 8 + Math.random() * 84;
      const drift = Math.round((Math.random() - 0.5) * 320);
      const rotation = Math.round(Math.random() * 900 - 450);
      node.style.setProperty('--x', `${x}%`);
      node.style.setProperty('--drift', `${drift}px`);
      node.style.setProperty('--rotation', `${rotation}deg`);
      node.style.setProperty('--delay', `${Math.random() * 450}ms`);
      node.style.setProperty('--fall-time', `${2200 + Math.random() * 1500}ms`);
      confettiField.append(node);
    }
  }

  function resetPresentation() {
    stage.classList.remove('is-playing', 'is-open', 'is-burst', 'is-generic', 'is-fading');
    box.style.animation = 'none';
    void box.offsetWidth;
    box.style.animation = '';
    revealList.replaceChildren();
    finale.hidden = true;
    welcomeCard.hidden = true;
    confettiField.replaceChildren();
    title.textContent = "Something's on the way";
    subtitle.textContent = 'Good things travel together.';
  }

  function later(callback, delay) {
    const timer = setTimeout(callback, delay);
    presentationTimers.push(timer);
    return timer;
  }

  function showArrival(message) {
    clearPresentationTimers();
    resetPresentation();

    const raider = String(message.raider ?? 'A streamer');
    const viewers = Math.max(0, Number(message.viewers ?? 0));
    const items = Array.isArray(message.items) ? message.items.slice(0, 15) : [];
    const hasPackage = Boolean(message.packageFound);
    stage.classList.toggle('is-generic', !hasPackage);
    title.textContent = hasPackage ? 'A gift from the other side' : 'A new community just arrived';
    subtitle.textContent = hasPackage ? `${raider} brought a little something` : `${raider} is bringing ${viewers.toLocaleString()} new friends`;
    stage.classList.add('is-playing');
    populateConfetti(items);

    const anticipation = 2500;
    later(() => stage.classList.add('is-burst', 'is-open'), anticipation);

    const revealStart = anticipation + 400;
    items.forEach((item, index) => {
      later(() => revealList.append(makeItem(item, index)), revealStart + index * 2500);
    });

    const finaleAt = hasPackage
      ? revealStart + items.length * 2500
      : revealStart + 600;
    later(() => {
      finaleTitle.textContent = `${items.length} ${items.length === 1 ? 'gift' : 'gifts'} from ${raider}'s community`;
      finaleUsers.textContent = items.map(item => String(item.user ?? 'viewer')).join('  ·  ');
      finale.hidden = false;
    }, finaleAt);

    const welcomeAt = finaleAt + 1800;
    later(() => {
      welcomeTitle.textContent = `Welcome, ${raider}'s community!`;
      welcomeDetail.textContent = `${viewers.toLocaleString()} raiders · one big welcome`;
      welcomeCard.hidden = false;
      console.info('[overlay:unbox] welcome card shown');
      later(() => {
        stage.classList.add('is-fading');
        later(resetPresentation, 1000);
      }, 8000);
    }, welcomeAt);
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
