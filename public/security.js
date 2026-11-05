// The security window. Draws whatever main sends, with textContent only, and
// sends back what was typed. It holds no logic and keeps nothing.
(() => {
  const root = document.getElementById('root');
  const api = window.kryptSecurity;
  let busy = false;

  const el = (tag, props) => {
    const n = document.createElement(tag);
    if (props) Object.assign(n, props);
    return n;
  };

  const drawQr = (modules) => {
    const scale = 5;
    const quiet = 4;
    const size = (modules.length + quiet * 2) * scale;
    const c = el('canvas', { width: size, height: size });
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      });
    });
    return c;
  };

  const fit = () => void api.resize(document.documentElement.scrollHeight);

  const send = async (action, values) => {
    if (busy) return;
    busy = true;
    for (const b of root.querySelectorAll('button')) b.disabled = true;
    const next = await api.act(action, values);
    busy = false;
    if (!next || next.closed) return;
    render(next);
  };

  const render = (view) => {
    root.replaceChildren();
    root.append(el('h1', { textContent: view.title, className: view.danger ? 'danger' : '' }));
    for (const line of view.lines) root.append(el('p', { textContent: line }));
    if (view.secret) root.append(el('div', { textContent: view.secret, className: 'secret' }));
    if (view.qr) root.append(drawQr(view.qr));

    const inputs = [];
    for (const f of view.fields) {
      root.append(el('label', { textContent: f.label, htmlFor: `f_${f.name}` }));
      const input = el('input', {
        id: `f_${f.name}`,
        type: f.kind === 'password' ? 'password' : 'text',
        autocomplete: 'off',
        spellcheck: false,
      });
      if (f.kind === 'code') input.inputMode = 'text';
      input.dataset.name = f.name;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
      root.append(input);
      if (f.hint) root.append(el('p', { textContent: f.hint, className: 'hint' }));
      inputs.push(input);
    }
    if (view.error) root.append(el('div', { textContent: view.error, className: 'error' }));

    function submit() {
      const values = {};
      for (const i of inputs) values[i.dataset.name] = i.value;
      void send('submit', values);
    }

    const row = el('div', { className: 'row' });
    for (const x of view.extra || []) {
      const b = el('button', { textContent: x.label, className: 'link', type: 'button' });
      b.addEventListener('click', () => void send(x.id, {}));
      row.append(b);
    }
    row.append(el('div', { className: 'spacer' }));
    if (view.cancel !== null) {
      const c = el('button', { textContent: view.cancel || 'Cancel', type: 'button' });
      c.addEventListener('click', () => void send('cancel', {}));
      row.append(c);
    }
    const go = el('button', { textContent: view.submit, className: `primary${view.danger ? ' danger' : ''}`, type: 'button' });
    go.addEventListener('click', submit);
    row.append(go);
    root.append(row);

    if (inputs[0]) inputs[0].focus();
    else go.focus();
    fit();
  };

  // Nothing written on this window goes anywhere by menu or shortcut.
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('copy', (e) => {
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const closable = [...root.querySelectorAll('button')].some((b) => !b.classList.contains('primary') && !b.classList.contains('link'));
      if (closable) void send('cancel', {});
    }
  });

  void api.view().then((v) => {
    if (v) render(v);
  });
})();
