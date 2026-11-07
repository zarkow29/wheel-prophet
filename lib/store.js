// Tiny JSON store, one writer per file.
// The poller owns state.json; the server owns plays.json. Readers reload when the
// file's mtime changes, so the two processes see each other's writes without a lock.
const fs = require('fs');
const path = require('path');

function make(file, empty) {
  const full = path.join(__dirname, '..', 'data', file);
  let data = null;
  let mtime = 0;

  const load = () => {
    try {
      const st = fs.statSync(full);
      if (!data || st.mtimeMs !== mtime) {
        data = JSON.parse(fs.readFileSync(full, 'utf8'));
        mtime = st.mtimeMs;
      }
    } catch {
      if (!data) data = structuredClone(empty);
    }
    return data;
  };

  const save = () => {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = `${full}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, full);
    mtime = fs.statSync(full).mtimeMs;
    return full;
  };

  return {
    path: full,
    read: (fn) => fn(load()),
    mutate: (fn) => {
      const d = load();
      const out = fn(d);
      save();
      return out;
    },
    save,
  };
}

module.exports = { make };
