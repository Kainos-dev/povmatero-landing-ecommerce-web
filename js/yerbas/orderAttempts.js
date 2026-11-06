// An unresolved purchase never expires locally: expiry belongs to its reservation,
// not to the idempotency key. Separate accounts and cart operations stay separate.
const PREFIX = "povmatero-yerbas-operation-v2:";
function browserStorage(name) { try { return globalThis[name]; } catch { return null; } }

export function createOrderAttempts(options = {}) {
  const storage = options.storage ?? browserStorage("localStorage");
  const legacyStorage = options.legacyStorage ?? browserStorage("sessionStorage");
  const locks = options.locks ?? globalThis.navigator?.locks;
  const cryptoApi = options.crypto ?? globalThis.crypto;
  const memory = new Map();
  const nameFor = (owner, signature) => `${PREFIX}${owner}:${signature}`;
  function find(owner, signature) {
    const name = nameFor(owner, signature);
    let saved = memory.get(name);
    try { saved = JSON.parse(storage?.getItem(name) ?? "null") ?? saved; } catch { /* memory fallback */ }
    if (saved?.owner === owner && saved.signature === signature && saved.key) return saved;
    // Keep the key of an unresolved operation made by the previous frontend.
    try {
      const old = JSON.parse(legacyStorage?.getItem("povmatero-yerbas-attempt") ?? "null");
      if (old?.owner === owner && old.signature === signature && old.key)
        return { ...old, status: "pending", revision: "legacy" };
    } catch { /* no legacy operation */ }
    return null;
  }
  function save(record) {
    try {
      if (!storage) throw new Error("No storage");
      storage.setItem(nameFor(record.owner, record.signature), JSON.stringify(record));
    } catch {
      throw Object.assign(new Error("Para evitar pedidos duplicados, habilitá el almacenamiento del navegador y volvé a intentar."), { hint: "attempt_storage" });
    }
    memory.set(nameFor(record.owner, record.signature), record);
    return record;
  }
  async function prepare(owner, signature, revision) {
    const saved = find(owner, signature);
    if (saved && (saved.status === "pending" || saved.revision === revision)) return save(saved);
    // Same shared cart revision => same key even without Web Locks, including
    // two tabs racing to initialize their first operation. Cart revisions are random.
    const bytes = new Uint8Array(await cryptoApi.subtle.digest("SHA-256",
      new TextEncoder().encode(JSON.stringify([owner, revision, signature])))).slice(0, 16);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(n => n.toString(16).padStart(2, "0")).join("");
    const key = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    const current = find(owner, signature);
    if (current && (current.status === "pending" || current.revision === revision)) return save(current);
    return save({ owner, signature, revision, key, status: "pending", at: Date.now() });
  }
  function complete(attempt) {
    if (!attempt) return;
    const saved = find(attempt.owner, attempt.signature);
    if (saved?.key !== attempt.key) return;
    // Don't turn a successful server response into another checkout on storage failure.
    try { save({ ...saved, status: "resolved" }); } catch { /* same key remains safe */ }
    try {
      const old = JSON.parse(legacyStorage?.getItem("povmatero-yerbas-attempt") ?? "null");
      if (old?.key === attempt.key) legacyStorage.removeItem("povmatero-yerbas-attempt");
    } catch { /* no legacy storage */ }
  }
  const withLock = async (owner, task) => {
    if (!locks?.request) return task();
    let entered = false;
    try { return await locks.request(`povmatero:yerbas-checkout:${owner ?? "guest"}`, () => { entered = true; return task(); }); }
    catch (error) { if (!entered) return task(); throw error; }
  };
  return { find, prepare, complete, withLock };
}
