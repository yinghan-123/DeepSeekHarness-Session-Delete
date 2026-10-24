/**
 * Host half of the `dsh-session-clean` bundle.
 *
 * DSH ships archive/pin/rename/fork for sidebar sessions but no way to delete
 * one. This plugin adds exactly that, behind a small private HTTP surface the
 * client half calls:
 *
 *   GET  /_dsh-session-clean/status?sessionId=…   → { busy, detail, resident }
 *   POST /_dsh-session-clean/delete {sessionId}   → { ok, workspaces, archived,
 *       pinned, removed, live, unloaded, unloadDetail, hidden, trashed }
 *   GET  /_dsh-session-clean/trash                → { ok, entries, bytes }
 *   POST /_dsh-session-clean/trash/restore {sessionId}
 *   POST /_dsh-session-clean/trash/purge   {sessionId}
 *   POST /_dsh-session-clean/trash/empty
 *
 * Deletion is a hard contract, not a UI nicety, and it proceeds in order:
 *
 *   1. re-probe for live work (running turn, pending approval / answer) and
 *      refuse while any of it is active — even if the sidebar UI was stale;
 *   2. if the session is still resident in the Host's live store, unload it
 *      for real (see {@link unloadLiveSession}) so the browser DROPS its row
 *      instead of merely hiding it;
 *   3. remove the session from the workspace registry through the SAME
 *      storage-domain handle the registry already holds open
 *      (`storageDomain.get`), so every write persists durably AND emits
 *      `domain/changed`, which is what makes the open sidebar refresh;
 *   4. erase the durable payload: the session directory under
 *      `~/.dsh/sessions/<workspace>/<sessionId>/`, its `session_projcache`
 *      record and backing file, and its spilled tool results under the spill
 *      backend's session-hashed directory.
 *
 * Steps 1, 3 and 4 rest on documented contracts. Step 2 does not: DSH ships no
 * session-unload API, so it reaches the framework's own teardown (see
 * {@link unloadLiveSession}). When that probe fails the plugin falls back to
 * hiding the residual row and SAYS SO in its response — it never reports a
 * clean deletion it did not achieve.
 *
 * Runtime contracts verified against app.asar 0.2.0-rc.2:
 *   * `WebRoute = { kind, path, handler(req, res) }` — a NODE handler pair;
 *   * a plugin route is PUBLIC unless it checks `ctx.connection` itself;
 *   * `ctx.storageDomain.get(name)` returns the single open domain instance;
 *     `domain.table(name)` is a validated KV handle whose `put/update/delete`
 *     persist first, then mutate memory, then emit `domain/changed`;
 *   * `domain.global` is the same contract for the domain's singleton state.
 */

import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { rm, readdir, rename, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'

const TAG = '[session-delete]'

/** Private route prefix. `/api` and `/plugins` belong to other hosts. */
const ROUTE_PREFIX = '/_dsh-session-clean'

/** Largest group one pre-flight may cover; keeps the query string bounded. */
const BATCH_LIMIT = 200

/** Sessions live per-workspace under the DSH home. Tests may redirect the root. */
const sessionsRoot = () => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  const dshHome = process.env.DSH_SESSION_DELETE_HOME ?? process.env.DSH_HOME ?? join(home, '.dsh')
  return join(dshHome, 'sessions')
}

/** Best-effort projection-cache store beside the workspace registry file. */
const projcacheSessionsDir = () => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  const dshHome = process.env.DSH_SESSION_DELETE_HOME ?? process.env.DSH_HOME ?? join(home, '.dsh')
  return join(dshHome, 'storages', 'session_projcache', 'sessions')
}

/** A session id is always `session-<uuid>`; anything else is rejected early. */
const SESSION_ID_RE = /^session-[0-9a-fA-F-]{36}$/

/**
 * Directory holding the spill backend's private per-process roots. The real
 * default is the OS temp dir; tests redirect it the same way they redirect the
 * DSH home, so a test run can never touch a real spill root.
 */
const spillBase = () => process.env.DSH_SESSION_DELETE_TMP ?? tmpdir()

/**
 * Default spill-root name, as minted by `mkdtempSync(join(tmpdir(),
 * 'dsh-spill-'))`: the prefix plus exactly six random characters. The backend's
 * own startup sweep matches this exact shape rather than the bare prefix, so a
 * foreign `dsh-spill-…` directory is never swept; we hold to the same rule.
 */
const SPILL_ROOT_RE = /^dsh-spill-[A-Za-z0-9_-]{6}$/

/**
 * Session-scoped spill directory name — byte-for-byte the backend's
 * `sessionDir()`: `session-` plus the first 12 hex digits of
 * `sha256(sessionId)`.
 * @param {string} sessionId - a `session-<uuid>` id.
 * @returns {string} that session's spill directory name.
 */
const spillSessionDirName = (sessionId) =>
  `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`

/** Operation log beside the DSH logs — the crash dialog shows symptoms, this file shows causes. */
const opLogPath = () => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  const dshHome = process.env.DSH_SESSION_DELETE_HOME ?? process.env.DSH_HOME ?? join(home, '.dsh')
  return join(dshHome, 'logs', 'session-delete.log')
}

/** Append one timestamped line; diagnostics must never break the request path. */
async function opLog(line) {
  try {
    mkdirSync(dirname(opLogPath()), { recursive: true })
    appendFileSync(opLogPath(), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* swallow */
  }
}

/* ------------------------------------------------------------------ *
 * Recycle bin
 *
 * `delete` does not destroy the payload any more: the session directory is
 * RENAMED into `$DSH_HOME/session-trash/<sessionId>/payload/`, its
 * projection-cache record and its spilled tool output are moved alongside,
 * and `meta.json` records everything a restore needs — the display title, the
 * owning workspace (id / title / path / on-disk directory) and the archived /
 * pinned flags the registry held for that session.
 *
 * Restoring is the reverse move plus the registry re-entry. DSH lists a
 * session from the persisted corpus (session-query `listSessions` = the
 * persistence listing ∪ the live store), so a restored directory shows up
 * again as soon as the client refreshes its list — no restart involved.
 * `purge` and `empty` are the only code paths that unlink session data.
 * ------------------------------------------------------------------ */

/** Bumped whenever the on-disk entry layout changes. */
const TRASH_META_VERSION = 1

/** The DSH home the rest of this file resolves its roots from. */
const dshHomeDir = () => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  return process.env.DSH_SESSION_DELETE_HOME ?? process.env.DSH_HOME ?? join(home, '.dsh')
}

/** Recycle-bin root: a sibling of `sessions/` under the DSH home. */
const trashRoot = () => join(dshHomeDir(), 'session-trash')

/** @param {string} sessionId - a `session-<uuid>` id. @returns {string} its bin entry. */
const trashEntryDir = (sessionId) => join(trashRoot(), sessionId)

/** @param {string} entryDir - one bin entry. @returns {string} its metadata path. */
const trashMetaFile = (entryDir) => join(entryDir, 'meta.json')

/** @param {string} entryDir - one bin entry. @returns {string} where the moved session dir sits. */
const trashPayloadDir = (entryDir) => join(entryDir, 'payload')

/**
 * Locate one session's on-disk directory. A session lives under exactly one
 * workspace directory; the workspace name is captured so a restore can put it
 * back into the same place.
 * @param {string} sessionId - the session to look for.
 * @returns {{ workspaceDir: string, path: string } | null} its directory.
 */
function findSessionDir(sessionId) {
  const root = sessionsRoot()
  if (!existsSync(root)) return null
  let workspaceDirs
  try {
    workspaceDirs = readdirSync(root)
  } catch {
    return null
  }
  for (const workspaceDir of workspaceDirs) {
    const path = join(root, workspaceDir, sessionId)
    if (existsSync(path)) return { workspaceDir, path }
  }
  return null
}

/**
 * Read one session's display title. The projection cache holds it, and the
 * cache record is deliberately cleared by a delete — so this has to run
 * BEFORE that, both through the live domain and through the backing file.
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session whose title to read.
 * @returns {string} the title, or '' when the cache has none.
 */
function readSessionTitle(ctx, sessionId) {
  const candidates = []
  try {
    const facility = serviceOf(ctx, 'storageDomain')
    const table = facility?.get?.('session_projcache')?.table?.('sessions')
    for (const key of [sessionId, uuidOf(sessionId)]) {
      try {
        const value = table?.get?.(key)
        if (value !== undefined && value !== null) candidates.push(value)
      } catch {
        /* a missing key is not an error */
      }
    }
  } catch {
    /* the domain may be closed; the file below still answers */
  }
  for (const file of [
    join(projcacheSessionsDir(), `${sessionId}.json`),
    join(projcacheSessionsDir(), `${uuidOf(sessionId)}.json`),
  ]) {
    try {
      if (existsSync(file)) candidates.push(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      /* unreadable cache is the same as no cache here */
    }
  }
  for (const candidate of candidates) {
    const title =
      candidate?.record?.rows?.title?.val ??
      candidate?.rows?.title?.val ??
      candidate?.title
    if (typeof title === 'string' && title.trim() !== '') return title.trim()
  }
  return ''
}

/**
 * Total size of one directory tree. Display only — an unreadable child is
 * skipped instead of failing the listing.
 * @param {string} path - the directory to measure.
 * @returns {number} bytes.
 */
function dirBytes(path) {
  let total = 0
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    try {
      if (entry.isDirectory()) total += dirBytes(child)
      else total += statSync(child).size
    } catch {
      /* raced away */
    }
  }
  return total
}

/**
 * Find this session's spill directories across the spill backend's private
 * roots (same discovery rule as {@link eraseSpill}).
 * @param {string} sessionId - the session whose spill dirs to find.
 * @returns {Promise<Array<{ rootName: string, path: string }>>} what exists.
 */
async function findSpillDirs(sessionId) {
  const found = []
  let entries
  try {
    entries = await readdir(spillBase())
  } catch {
    return found
  }
  const name = spillSessionDirName(sessionId)
  for (const entry of entries) {
    if (!SPILL_ROOT_RE.test(entry)) continue
    const path = join(spillBase(), entry, name)
    if (existsSync(path)) found.push({ rootName: entry, path })
  }
  return found
}

/**
 * Move one session's durable payload into the recycle bin.
 *
 * Order matters: the caller has already unloaded the session, so the log
 * writer is closed and the directory is quiescent. The rename keeps the bytes
 * exactly as they were; only the path changes, which is what makes a restore
 * a plain move back.
 *
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session to bin.
 * @param {object} facts - title / owning workspace / archived / pinned.
 * @returns {Promise<object | null>} the entry metadata, or null when the
 *   session never reached the disk (nothing to keep, nothing to restore).
 */
async function moveToTrash(ctx, sessionId, facts) {
  const found = findSessionDir(sessionId)
  if (found === null) return null
  const entryDir = trashEntryDir(sessionId)
  // A leftover entry can only be a stale copy of this same session; the
  // delete the user just confirmed outranks it.
  if (existsSync(entryDir)) {
    await rm(entryDir, { recursive: true, force: true })
    await opLog(`回收站旧条目已覆盖: ${sessionId}`)
  }
  const payloadDir = trashPayloadDir(entryDir)
  await mkdir(entryDir, { recursive: true })
  await rename(found.path, payloadDir)

  const moved = ['payload']
  // The projection cache is about to be invalidated; keep a byte copy so a
  // restore can put the very same document back.
  for (const name of [`${sessionId}.json`, `${uuidOf(sessionId)}.json`]) {
    const source = join(projcacheSessionsDir(), name)
    if (!existsSync(source)) continue
    try {
      await copyFile(source, join(entryDir, 'projcache.json'))
      moved.push('projcache')
      break
    } catch (error) {
      await opLog(`回收站缓存备份失败 ${name}: ${error?.message ?? error}`)
    }
  }
  // Oversized tool output lives outside the DSH home; move it aside too.
  try {
    const spillDirs = await findSpillDirs(sessionId)
    if (spillDirs.length > 0) {
      const spillHome = join(entryDir, 'spill')
      await mkdir(spillHome, { recursive: true })
      for (const spill of spillDirs) {
        try {
          await rename(spill.path, join(spillHome, spill.rootName))
          moved.push(`spill:${spill.rootName}`)
        } catch (error) {
          await opLog(`回收站溢出目录搬运失败 ${spill.path}: ${error?.message ?? error}`)
        }
      }
    }
  } catch (error) {
    await opLog(`回收站溢出目录扫描失败: ${error?.message ?? error}`)
  }

  const meta = {
    version: TRASH_META_VERSION,
    sessionId,
    title: typeof facts?.title === 'string' ? facts.title : '',
    workspaceId: typeof facts?.workspaceId === 'string' ? facts.workspaceId : '',
    workspaceTitle: typeof facts?.workspaceTitle === 'string' ? facts.workspaceTitle : '',
    workspacePath: typeof facts?.workspacePath === 'string' ? facts.workspacePath : '',
    workspaceDir: found.workspaceDir,
    archived: facts?.archived === true,
    pinned: facts?.pinned === true,
    deletedAt: new Date().toISOString(),
    bytes: dirBytes(payloadDir),
    moved,
  }
  await writeFile(trashMetaFile(entryDir), JSON.stringify(meta, null, 2), 'utf8')
  return meta
}

/**
 * List the recycle bin, newest first. A missing or unreadable `meta.json`
 * still yields a row (name-only): a half-moved entry must stay purgeable
 * rather than vanish from the panel.
 * @returns {Promise<{ entries: object[], bytes: number }>} the bin.
 */
async function listTrash() {
  const root = trashRoot()
  let names
  try {
    names = await readdir(root)
  } catch {
    return { entries: [], bytes: 0 }
  }
  const entries = []
  for (const name of names) {
    if (!SESSION_ID_RE.test(name)) continue
    const entryDir = join(root, name)
    let meta = null
    try {
      meta = JSON.parse(await readFile(trashMetaFile(entryDir), 'utf8'))
    } catch {
      meta = null
    }
    const bytes = dirBytes(entryDir)
    entries.push({
      sessionId: name,
      title: typeof meta?.title === 'string' ? meta.title : '',
      deletedAt: typeof meta?.deletedAt === 'string' ? meta.deletedAt : '',
      workspaceTitle: typeof meta?.workspaceTitle === 'string' ? meta.workspaceTitle : '',
      workspacePath: typeof meta?.workspacePath === 'string' ? meta.workspacePath : '',
      archived: meta?.archived === true,
      pinned: meta?.pinned === true,
      bytes,
      restorable: existsSync(trashPayloadDir(entryDir)),
    })
  }
  entries.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)))
  return { entries, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) }
}

/**
 * Put one binned session back: move the payload to its original workspace
 * directory, restore the cache copy and the spill directory, then re-enter the
 * workspace registry (archived / pinned flags included).
 *
 * A session that is still resident in the live store is refused: restoring it
 * would hand the list a second copy of a session that never left memory.
 *
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the binned session to restore.
 * @returns {Promise<object>} what was restored and where.
 */
async function restoreFromTrash(ctx, sessionId) {
  const entryDir = trashEntryDir(sessionId)
  if (!existsSync(entryDir)) throw Object.assign(new Error('回收站里没有这个会话'), { statusCode: 404 })
  if (isResident(ctx, sessionId)) {
    throw Object.assign(new Error('该会话仍驻留在内存里，重启 DSH 后再恢复'), { statusCode: 409 })
  }
  const payloadDir = trashPayloadDir(entryDir)
  if (!existsSync(payloadDir)) {
    throw Object.assign(new Error('回收站条目里没有会话数据，无法恢复（可彻底删除）'), { statusCode: 409 })
  }
  let meta = {}
  try {
    meta = JSON.parse(await readFile(trashMetaFile(entryDir), 'utf8'))
  } catch {
    meta = {}
  }
  const workspaceDir = typeof meta?.workspaceDir === 'string' ? meta.workspaceDir : ''
  if (workspaceDir === '') {
    throw Object.assign(new Error('回收站条目缺少原始目录信息，无法恢复'), { statusCode: 409 })
  }
  const target = join(sessionsRoot(), workspaceDir, sessionId)
  if (existsSync(target)) {
    throw Object.assign(new Error('原位置已存在同名会话，恢复会覆盖它，已中止'), { statusCode: 409 })
  }
  await mkdir(dirname(target), { recursive: true })
  await rename(payloadDir, target)
  const restored = [target]

  // Projection cache: it is a fold shortcut, never an authority, so nothing
  // here may fail the restore. While the process runs, the DOMAIN's in-memory
  // table is authoritative — copying the file back would only take effect
  // after a restart — so the original record is put back through the live
  // domain first, with the file copy as the fallback.
  const cacheCopy = join(entryDir, 'projcache.json')
  if (existsSync(cacheCopy)) {
    let document
    try {
      document = JSON.parse(await readFile(cacheCopy, 'utf8'))
    } catch (error) {
      document = undefined
      await opLog(`回收站缓存副本不可读 ${sessionId}: ${error?.message ?? error}`)
    }
    const record = document?.record ?? document
    let restoredRecord = false
    if (record !== undefined && record !== null && typeof record === 'object') {
      try {
        const table = serviceOf(ctx, 'storageDomain')?.get?.('session_projcache')?.table?.('sessions')
        if (table && typeof table.put === 'function') {
          await table.put(sessionId, record)
          restoredRecord = true
          restored.push(`session_projcache#sessions:${sessionId}`)
        }
      } catch (error) {
        await opLog(`恢复缓存记录失败（靠自愈）: ${sessionId} ${error?.message ?? error}`)
      }
    }
    if (!restoredRecord) {
      try {
        const cacheFile = join(projcacheSessionsDir(), `${sessionId}.json`)
        await mkdir(projcacheSessionsDir(), { recursive: true })
        await copyFile(cacheCopy, cacheFile)
        restored.push(cacheFile)
      } catch (error) {
        await opLog(`恢复缓存副本失败 ${sessionId}: ${error?.message ?? error}`)
      }
    }
  }

  // Spill: only when the same spill root still exists in this process.
  const spillHome = join(entryDir, 'spill')
  if (existsSync(spillHome)) {
    let rootNames = []
    try {
      rootNames = await readdir(spillHome)
    } catch {
      rootNames = []
    }
    for (const rootName of rootNames) {
      try {
        const spillTarget = join(spillBase(), rootName, spillSessionDirName(sessionId))
        if (!existsSync(dirname(spillTarget))) continue
        await mkdir(dirname(spillTarget), { recursive: true })
        await rename(join(spillHome, rootName), spillTarget)
        restored.push(spillTarget)
      } catch (error) {
        await opLog(`恢复溢出目录失败 ${rootName}: ${error?.message ?? error}`)
      }
    }
  }

  // The bytes are back on disk at this point. A registry failure must not turn
  // that into a failed restore: unregistered ids still list under Ungrouped.
  let registry = { registry: false, workspace: '', workspaceId: typeof meta?.workspaceId === 'string' ? meta.workspaceId : '' }
  try {
    registry = await restoreInRegistry(ctx, sessionId, meta)
  } catch (error) {
    await opLog(`恢复注册表失败（目录已还原，将出现在未分组）: ${error?.message ?? error}`)
  }
  await rm(entryDir, { recursive: true, force: true })
  return {
    sessionId,
    title: typeof meta?.title === 'string' ? meta.title : '',
    workspaceDir,
    restored,
    ...registry,
  }
}

/**
 * Resolve the workspace registry service without making it a load-time
 * dependency (`dsh-workspace` may be composed differently).
 * @param {object} ctx - the Host plugin context.
 * @returns {object|undefined} the registry when mounted.
 */
function workspaceRegistryOf(ctx) {
  for (const key of ['workspaceRegistry', 'workspace']) {
    const service = serviceOf(ctx, key)
    if (service && typeof service.list === 'function') return service
  }
  return undefined
}

/**
 * Find one workspace entity by id.
 * @param {object|undefined} registry - the workspace registry.
 * @param {string} workspaceId - the id to look up.
 * @returns {object|undefined} the entity (`attachSession` lives on it).
 */
function workspaceEntityOf(registry, workspaceId) {
  if (!registry || workspaceId === '') return undefined
  try {
    if (typeof registry.get === 'function') {
      const entity = registry.get(workspaceId)
      if (entity !== undefined) return entity
    }
  } catch {
    /* fall through to the list scan */
  }
  try {
    const workspaces = typeof registry.list === 'function' ? registry.list() : []
    return workspaces.find((workspace) => workspace && workspace.id === workspaceId)
  } catch {
    return undefined
  }
}

/**
 * Re-enter a restored session into the workspace registry.
 *
 * The group write MUST go through {@link WorkspaceEntity.attachSession}, not
 * through the domain table: `WorkspaceEntity.sessionIds` filters its own
 * record by the registry's `sessionPaths` index, so a raw table write shows up
 * for the current page only — the next reconnect baseline and the next start
 * drop the session back into Ungrouped. `attachSession` does the three things
 * that matter, in one durable step: it reads the restored header, remembers
 * its path in that index, and swaps the record snapshot (which emits
 * `domain/changed`).
 *
 * A raw table write stays as the fallback so a probe miss still leaves the
 * session reachable from the current page.
 *
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session to re-enter.
 * @param {object} meta - its bin metadata.
 * @returns {Promise<object>} registry facts.
 */
async function restoreInRegistry(ctx, sessionId, meta) {
  const workspaceId = typeof meta?.workspaceId === 'string' ? meta.workspaceId : ''
  const result = {
    registry: false,
    workspace: '',
    workspaceId,
    attached: false,
    archived: false,
    pinned: false,
    detail: '',
  }
  const registry = workspaceRegistryOf(ctx)
  const entity = workspaceEntityOf(registry, workspaceId)

  if (entity && typeof entity.attachSession === 'function') {
    try {
      await entity.attachSession(sessionId)
      result.attached = true
      result.registry = true
      result.workspace = entity.title ?? ''
    } catch (error) {
      result.detail = `attachSession: ${error?.message ?? error}`
      await opLog(`attachSession 失败（回退直接写注册表）: ${sessionId} ${result.detail}`)
    }
  }

  if (!result.attached && workspaceId !== '') {
    const domain = serviceOf(ctx, 'storageDomain')?.get?.('workspace')
    if (domain && typeof domain.table === 'function') {
      try {
        const table = domain.table('workspaces')
        const record = table.get(workspaceId)
        if (record !== undefined && record !== null) {
          const sessionIds = Array.isArray(record.sessionIds) ? record.sessionIds : []
          if (!sessionIds.includes(sessionId)) {
            await table.update(workspaceId, () => ({
              ...record,
              sessionIds: [sessionId, ...sessionIds],
              updatedAt: new Date().toISOString(),
            }))
          }
          result.registry = true
          result.workspace = record.title ?? ''
          result.detail = result.detail === '' ? 'domain-fallback' : `${result.detail}; domain-fallback`
        } else {
          result.detail = result.detail === '' ? 'group-gone' : `${result.detail}; group-gone`
        }
      } catch (error) {
        await opLog(`恢复注册表回退失败: ${sessionId} ${error?.message ?? error}`)
      }
    }
  } else if (workspaceId === '') {
    result.detail = 'no-workspace'
  }

  // Archived / pinned are registry-global sets; use the registry's own writers
  // so the in-memory state moves with the durable one.
  try {
    if (meta?.archived === true) {
      if (typeof registry?.archiveSession === 'function') await registry.archiveSession(sessionId)
      result.archived = true
    } else if (meta?.pinned === true) {
      if (typeof registry?.pinSession === 'function') await registry.pinSession(sessionId)
      result.pinned = true
    }
  } catch (error) {
    await opLog(`恢复归档/置顶失败: ${sessionId} ${error?.message ?? error}`)
    result.detail = `${result.detail === '' ? '' : `${result.detail}; `}flag-failed`
  }
  return result
}

/**
 * Really delete one bin entry.
 * @param {string} sessionId - the binned session to erase.
 * @returns {Promise<boolean>} whether an entry existed.
 */
async function purgeTrashEntry(sessionId) {
  const entryDir = trashEntryDir(sessionId)
  if (!existsSync(entryDir)) return false
  await rm(entryDir, { recursive: true, force: true })
  return true
}

/**
 * Really delete every bin entry.
 * @returns {Promise<number>} how many entries were erased.
 */
async function emptyTrash() {
  const root = trashRoot()
  if (!existsSync(root)) return 0
  let names = []
  try {
    names = await readdir(root)
  } catch {
    return 0
  }
  let count = 0
  for (const name of names) {
    if (!SESSION_ID_RE.test(name)) continue
    try {
      await rm(join(root, name), { recursive: true, force: true })
      count += 1
    } catch (error) {
      await opLog(`清空回收站失败 ${name}: ${error?.message ?? error}`)
    }
  }
  return count
}

export const name = 'session-delete'
export const inject = ['webServer', 'connection', 'storageDomain']

/**
 * @param {string} sessionId - a `session-<uuid>` id.
 * @returns {string} the bare uuid, e.g. for projection-cache file names.
 */
const uuidOf = (sessionId) => sessionId.slice('session-'.length)

/**
 * Best-effort liveness probe for one session. The sidebar already greys the
 * action while a turn runs; this is the authoritative re-check on the Host,
 * so a stale menu can never race a just-started task into a deletion.
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session to probe.
 * @returns {{ busy: boolean, detail: string }}
 */
function probeBusy(ctx, sessionId) {
  const agents = ctx.get?.('agents') ?? ctx.agents
  if (!agents || typeof agents.get !== 'function') {
    // Registry absent: refuse to guess. Deletion stays available only when we
    // can positively say the session has no live agent.
    return { busy: false, detail: 'agents-unavailable' }
  }
  let agent
  try {
    agent = agents.get(sessionId)
  } catch {
    agent = undefined
  }
  if (agent === undefined || agent === null) return { busy: false, detail: 'no-live-agent' }
  const snapshot =
    agent?.session?.getSnapshot?.() ??
    agent?.getSnapshot?.() ??
    (typeof agent?.session === 'object' ? undefined : undefined)
  const running =
    snapshot?.running === true ||
    snapshot?.pendingInteraction !== undefined && snapshot?.pendingInteraction !== null
  if (running) {
    return { busy: true, detail: snapshot?.running === true ? 'running' : 'pending-interaction' }
  }
  // A live agent that is provably idle is fine to delete behind.
  return { busy: false, detail: 'agent-idle' }
}

/**
 * Resolve one Host service without turning it into a load-time dependency.
 * @param {object} ctx - the Host plugin context.
 * @param {string} key - the service key.
 * @returns {object|undefined} the service when it is mounted.
 */
function serviceOf(ctx, key) {
  try {
    return ctx.get?.(key) ?? ctx[key]
  } catch {
    return undefined
  }
}

/**
 * Whether a session is still resident in the Host's live store. Residency is
 * the ONLY reason a fully erased session keeps a sidebar row: the client's
 * session list is the union of the persistence layer and
 * `ctx.sessions.list()`, live precedence winning (session-query
 * `listSessions`), and the sidebar's 未分组 bucket is exactly "a listed id no
 * workspace accounts for".
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session to test.
 * @returns {boolean} whether the Host still holds it in memory.
 */
function isResident(ctx, sessionId) {
  const sessions = serviceOf(ctx, 'sessions')
  if (!sessions || typeof sessions.get !== 'function') return false
  try {
    return sessions.get(sessionId) !== undefined
  } catch {
    return false
  }
}

/**
 * Make a resident session stop existing for real, instead of faking it.
 *
 * DSH ships no documented unload API (the generated catalog for `sessions`
 * ends at create/prepare/enter/announce/flush/get/list/fork), so this calls
 * the one framework-owned primitive that removes a live session from memory:
 * `SessionStore.liveEntryFor(session).detach()` — `store.delete` +
 * `attachments.delete` + `session/disposed`. Every consequence after that is
 * the framework's own reaction to that lifecycle edge:
 *
 *   * the session controller converts it to `api-session/removed`, the browser
 *     applies a `{kind:'remove'}` list mutation, and the row is DROPPED — not
 *     hidden — and a page reload cannot bring it back;
 *   * the projection cache runs its mandatory "detach" checkpoint and clears
 *     its dirty bookkeeping, so no pending write-behind timer survives to
 *     rewrite the cache record this plugin is about to erase;
 *   * the log writer closes and `Session.append` stops dispatching, so an
 *     erased session can never be persisted again.
 *
 * Reach-through caveat: `liveEntryFor`/`detachEntered` are plain prototype
 * methods, not catalogued API. Every step is probed and contained; a miss
 * returns `{unloaded:false}` and the caller degrades honestly. The session's
 * Agent is intentionally left registered — there is no public detach for it,
 * and poking its store would leave an invisible loop behind — so that residue
 * lives until the next restart and is documented as such. Only ever call this
 * for a session proven idle: flushing a detached session throws
 * `session "…" is not live in this store`.
 *
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the resident session to unload.
 * @returns {Promise<{ unloaded: boolean, detail: string }>} what happened.
 */
async function unloadLiveSession(ctx, sessionId) {
  const sessions = serviceOf(ctx, 'sessions')
  if (!sessions || typeof sessions.get !== 'function') return { unloaded: false, detail: 'sessions-unavailable' }
  let session
  try {
    session = sessions.get(sessionId)
  } catch (error) {
    return { unloaded: false, detail: `get-failed: ${error?.message ?? error}` }
  }
  if (session === undefined || session === null) return { unloaded: false, detail: 'not-resident' }
  if (typeof sessions.liveEntryFor !== 'function') return { unloaded: false, detail: 'no-liveEntryFor' }
  if (typeof sessions.detachEntered !== 'function') return { unloaded: false, detail: 'no-detachEntered' }
  try {
    const entry = sessions.liveEntryFor(session)
    if (entry === undefined || entry === null) return { unloaded: false, detail: 'no-entry' }
    sessions.detachEntered(entry)
  } catch (error) {
    return { unloaded: false, detail: `unload-failed: ${error?.message ?? error}` }
  }
  return isResident(ctx, sessionId)
    ? { unloaded: false, detail: 'still-resident' }
    : { unloaded: true, detail: 'detached' }
}

/**
 * DEGRADED FALLBACK — hide a row we could not unload, and label it as such.
 *
 * Used only when {@link unloadLiveSession} fails its capability probe (a DSH
 * build that moved the internals). It writes the id into DSH's global archive
 * set, which makes the default sidebar view (`archivedFilter: 'default'`)
 * filter the row out. Be exact about what this is and is not:
 *
 *   * NOT a deletion path. The row still exists; a user who switches the
 *     sidebar filter to “show archived” / “only archived” sees it return with
 *     an 已归档 badge, and unarchiving puts it back under 未分组 — the plugin
 *     only self-heals at its NEXT start;
 *   * it does freeze the session (the archived-session gate rejects
 *     `agent/pre-step`), which is what stops a resident session from writing
 *     new events and re-persisting itself;
 *   * the caller must therefore answer `unloaded:false, hidden:true` and the
 *     UI must say “hidden, not deleted”.
 *
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session to hide from the default list.
 * @returns {Promise<boolean>} whether the archived marker was written.
 */
async function hideLiveRemnant(ctx, sessionId) {
  const facility = ctx.get?.('storageDomain') ?? ctx.storageDomain
  const domain = facility?.get?.('workspace')
  if (!domain?.global) return false
  const state = { ...domain.global.get() }
  const archived = state.archivedSessionIds ?? []
  if (archived.includes(sessionId)) return false
  state.archivedSessionIds = [sessionId, ...archived]
  await domain.global.set(state)
  return true
}

/**
 * Drop archived/pinned ids whose session payload no longer exists anywhere.
 * These are dangles left by deleting a session that was still loaded in memory
 * (see {@link hideLiveRemnant}); a session id without a directory can never be
 * opened again, so the marker is pure noise.
 * @param {object} ctx - the Host plugin context.
 * @returns {Promise<number>} how many dangling ids were dropped.
 */
async function pruneDanglingIds(ctx) {
  const facility = ctx.get?.('storageDomain') ?? ctx.storageDomain
  const domain = facility?.get?.('workspace')
  if (!domain?.global) return 0
  const state = { ...domain.global.get() }
  const archived = state.archivedSessionIds ?? []
  const pinned = state.pinnedSessionIds ?? []
  if (archived.length === 0 && pinned.length === 0) return 0

  const root = sessionsRoot()
  if (!existsSync(root)) return 0
  const { readdir } = await import('node:fs/promises')
  const workspaceDirs = await readdir(root)
  const alive = (id) => workspaceDirs.some((dir) => existsSync(join(root, dir, id)))

  const nextArchived = archived.filter(alive)
  const nextPinned = pinned.filter(alive)
  const dropped = archived.length - nextArchived.length + (pinned.length - nextPinned.length)
  if (dropped === 0) return 0
  state.archivedSessionIds = nextArchived
  state.pinnedSessionIds = nextPinned
  await domain.global.set(state)
  await opLog(`启动清理: 移除 ${dropped} 个悬空标记（archived ${archived.length}→${nextArchived.length}, pinned ${pinned.length}→${nextPinned.length}）`)
  return dropped
}

/**
 * Remove the session from the workspace registry through the live domain
 * handle: global archive/pin sets plus every workspace's `sessionIds` row.
 * Writes emit `domain/changed`, so the open sidebar updates itself.
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session to forget.
 * @returns {Promise<{ workspaces: string[], archived: boolean, pinned: boolean }>}
 */
async function forgetInRegistry(ctx, sessionId) {
  const facility = ctx.get?.('storageDomain') ?? ctx.storageDomain
  const domain = facility?.get?.('workspace')
  await opLog(`forgetInRegistry: facility=${facility ? '有' : '无'} domain=${domain ? domain.name ?? 'workspace' : '无'}`)
  if (!domain || typeof domain.table !== 'function' || !domain.global) {
    throw new Error('workspace 存储域未打开，无法从注册表移除该会话')
  }

  const removed = { workspaces: [], owners: [], archived: false, pinned: false }

  // 1. Registry-global sets. Copy first: the global handle validates the
  //    whole state object on set.
  const globalState = { ...domain.global.get() }
  const archiveSet = globalState.archivedSessionIds ?? []
  const pinSet = globalState.pinnedSessionIds ?? []
  await opLog(`registry 全局: archived=${archiveSet.length} pinned=${pinSet.length} 含目标 archived=${archiveSet.includes(sessionId)} pinned=${pinSet.includes(sessionId)}`)
  if (archiveSet.includes(sessionId)) {
    removed.archived = true
    globalState.archivedSessionIds = archiveSet.filter((id) => id !== sessionId)
  }
  if (pinSet.includes(sessionId)) {
    removed.pinned = true
    globalState.pinnedSessionIds = pinSet.filter((id) => id !== sessionId)
  }
  if (removed.archived || removed.pinned) await domain.global.set(globalState)

  // 2. Per-workspace ownership rows.
  const table = domain.table('workspaces')
  let scanned = 0
  for (const [workspaceId, record] of table.entries()) {
    scanned += 1
    const owned = Array.isArray(record?.sessionIds) && record.sessionIds.includes(sessionId)
    await opLog(`registry 扫描 ${workspaceId}(${record?.title ?? '?'}): sessions=${record?.sessionIds?.length ?? '?'} 含目标=${owned}`)
    if (!owned) continue
    const next = {
      ...record,
      sessionIds: record.sessionIds.filter((id) => id !== sessionId),
      updatedAt: new Date().toISOString(),
    }
    await table.update(workspaceId, () => next)
    removed.workspaces.push(record.title || workspaceId)
    removed.owners.push({
      workspaceId,
      title: record.title ?? '',
      path: record.path ?? '',
    })
  }
  await opLog(`registry 扫描完成: 共 ${scanned} 个工作区, 命中 ${removed.workspaces.length}`)
  return removed
}

/**
 * Delete the session's durable log directory under `~/.dsh/sessions/`.
 * @param {string} sessionId - the session to erase.
 * @returns {Promise<string[]>} host paths actually removed.
 */
async function eraseSessionLog(sessionId) {
  const removed = []
  const root = sessionsRoot()
  if (!existsSync(root)) return removed
  for (const workspaceDir of await readdir(root)) {
    const target = join(root, workspaceDir, sessionId)
    if (!existsSync(target)) continue
    await rm(target, { recursive: true, force: true })
    removed.push(target)
  }
  return removed
}

/**
 * Delete the session's spilled tool results.
 *
 * Oversized tool output is stored OUTSIDE `~/.dsh` by `dsh-spill-local`, in a
 * session-scoped directory named `session-<sha256(sessionId)[0..12]>` under a
 * private root. With no configured root the backend mints its own
 * `dsh-spill-<6 chars>` directory under the OS temp dir, so the roots must be
 * discovered exactly the way the backend discovers them for its own startup
 * sweep; only the session-hash directory is removed, never a root.
 *
 * @param {string} sessionId - the session whose spill directory to erase.
 * @returns {Promise<string[]>} spill directories actually removed.
 */
async function eraseSpill(sessionId) {
  const removed = []
  let entries
  try {
    entries = await readdir(spillBase())
  } catch {
    return removed
  }
  const name = spillSessionDirName(sessionId)
  for (const entry of entries) {
    if (!SPILL_ROOT_RE.test(entry)) continue
    const target = join(spillBase(), entry, name)
    if (!existsSync(target)) continue
    try {
      await rm(target, { recursive: true, force: true })
      removed.push(target)
    } catch (error) {
      await opLog(`spill 删除失败 ${target}: ${error?.message ?? error}`)
    }
  }
  return removed
}

/**
 * Delete the session's projection-cache record: through the live
 * `session_projcache` domain when it is open, then through the backing file.
 *
 * The domain's real table is `sessions`, keyed by the FULL session id
 * (`session-projection-cache` does `domain.table('sessions')` and
 * `put(session.id, …)`), and its writes are durable-first — the medium is
 * written before memory, so deleting through the domain clears both the
 * per-record document and the in-memory row. That matters: while the row
 * survives, the next write-behind checkpoint recreates the file, which is how
 * a "deleted" session used to leave its title/outline/stats behind.
 *
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session whose cache record to erase.
 * @returns {Promise<string[]>} what was actually removed.
 */
async function eraseProjcache(ctx, sessionId) {
  const removed = []
  const uuid = uuidOf(sessionId)
  try {
    const facility = serviceOf(ctx, 'storageDomain')
    const cacheDomain = facility?.get?.('session_projcache')
    if (cacheDomain && typeof cacheDomain.table === 'function') {
      const table = cacheDomain.table('sessions')
      if (table && typeof table.delete === 'function') {
        for (const key of new Set([sessionId, uuid])) {
          try {
            // The domain's `delete` reports false for an absent key, so no
            // pre-check is needed and a missing record stays quiet.
            if (await table.delete(key)) removed.push(`session_projcache#sessions:${key}`)
          } catch (error) {
            await opLog(`projcache 域删除失败 ${key}: ${error?.message ?? error}`)
          }
        }
      }
    }
  } catch (error) {
    await opLog(`projcache 域不可用，改用文件删除: ${error?.message ?? error}`)
  }
  const cacheFiles = [
    join(projcacheSessionsDir(), `${sessionId}.json`),
    join(projcacheSessionsDir(), `${uuid}.json`),
  ]
  for (const cacheFile of cacheFiles) {
    if (!existsSync(cacheFile)) continue
    try {
      await rm(cacheFile, { force: true })
      removed.push(cacheFile)
    } catch (error) {
      await opLog(`projcache 文件删除失败 ${cacheFile}: ${error?.message ?? error}`)
    }
  }
  return removed
}

/**
 * Re-purge the projection cache shortly after a deletion that could NOT unload
 * the session. A deleted-but-resident session may still hold a pending
 * write-behind timer, and that timer rewrites the cache document once (the
 * cache's own "detach" flush only runs on the real unload path). One bounded,
 * unref'd retry keeps that residue from sticking.
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session to re-purge.
 * @returns {void}
 */
function scheduleResidualPurge(ctx, sessionId) {
  const timer = setTimeout(() => {
    void eraseProjcache(ctx, sessionId)
      .then((again) => opLog(`残留复清: ${sessionId} → ${again.length} 处`))
      .catch((error) => opLog(`残留复清失败: ${sessionId} ${error?.message ?? error}`))
  }, 8000)
  timer.unref?.()
}

/**
 * Delete the session's durable payload: the per-workspace directory under
 * `~/.dsh/sessions/`, the projection-cache record, and its spilled tool
 * results.
 * @param {object} ctx - the Host plugin context.
 * @param {string} sessionId - the session to erase.
 * @returns {Promise<string[]>} host paths actually removed.
 */
async function erasePayload(ctx, sessionId) {
  const removed = await eraseSessionLog(sessionId)
  removed.push(...(await eraseProjcache(ctx, sessionId)))
  removed.push(...(await eraseSpill(sessionId)))
  return removed
}

/** Read one JSON body; empty bodies resolve to {}. */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('请求体不是合法 JSON')
    error.statusCode = 400
    throw error
  }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

export function apply(ctx) {
  const log = (message, error) => {
    if (error === undefined) console.log(`${TAG} ${message}`)
    else console.warn(`${TAG} ${message}`, error)
  }

  const server = ctx.get?.('webServer') ?? ctx.webServer
  if (!server || typeof server.register !== 'function') {
    log('没有 webServer 服务，删除接口不可用（插件其余部分不受影响）')
    return
  }

  /** Same trust gate the shipped /api bridge uses; plugin routes are public otherwise. */
  const rejectUntrusted = (req, res) => {
    const connection = ctx.get?.('connection') ?? ctx.connection
    if (!connection) return false
    try {
      if (typeof connection.requestRejection === 'function') {
        const rejection = connection.requestRejection(req)
        if (rejection === undefined || rejection === null) return false
        sendJson(res, Number(rejection) || 403, { error: '未通过连接信任检查' })
        return true
      }
      if (typeof connection.admit === 'function') {
        const admission = connection.admit(req)
        if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
          sendJson(res, Number(admission.rejection) || 403, { error: '未通过连接信任检查' })
          return true
        }
      }
    } catch (error) {
      log('连接信任检查本身出错，放行本次请求', error)
    }
    return false
  }

  server.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (rejectUntrusted(req, res)) {
        await opLog(`REJECTED(trust) ${req.method} ${req.url}`)
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      try {
        if (url.pathname === `${ROUTE_PREFIX}/status` && req.method === 'GET') {
          const sessionId = url.searchParams.get('sessionId') ?? ''
          if (!SESSION_ID_RE.test(sessionId)) throw Object.assign(new Error('非法的 sessionId'), { statusCode: 400 })
          const probe = { ...probeBusy(ctx, sessionId), resident: isResident(ctx, sessionId) }
          await opLog(`status ${sessionId} → ${JSON.stringify(probe)}`)
          sendJson(res, 200, probe)
          return
        }
        // Bulk pre-flight for "clean a whole workspace": the client refuses the
        // WHOLE batch when any member owns live work — the single-session iron
        // rule, applied to a group. Deleting one-by-one afterwards stays gated
        // by /delete itself, so this is a pre-flight, not the enforcement.
        if (url.pathname === `${ROUTE_PREFIX}/precheck` && req.method === 'GET') {
          const raw = url.searchParams.get('sessionIds') ?? ''
          const ids = raw.split(',').map((part) => part.trim()).filter((part) => part !== '')
          if (ids.length === 0) throw Object.assign(new Error('sessionIds 不能为空'), { statusCode: 400 })
          if (ids.length > BATCH_LIMIT) {
            throw Object.assign(new Error(`一次最多预检 ${BATCH_LIMIT} 个会话`), { statusCode: 400 })
          }
          for (const id of ids) {
            if (!SESSION_ID_RE.test(id)) throw Object.assign(new Error('非法的 sessionId'), { statusCode: 400 })
          }
          const sessions = ids.map((id) => ({
            sessionId: id,
            ...probeBusy(ctx, id),
            resident: isResident(ctx, id),
          }))
          const busy = sessions.filter((entry) => entry.busy)
          await opLog(`precheck ${ids.length} 个会话，忙碌 ${busy.length} 个`)
          sendJson(res, 200, { total: ids.length, ok: busy.length === 0, busy, sessions })
          return
        }
        if (url.pathname === `${ROUTE_PREFIX}/delete` && req.method === 'POST') {
          const body = await readJsonBody(req)
          const sessionId = body?.sessionId
          if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
            throw Object.assign(new Error('非法的 sessionId'), { statusCode: 400 })
          }
          // Hard gate: never delete a session that still owns live work.
          const busy = probeBusy(ctx, sessionId)
          const resident = isResident(ctx, sessionId)
          await opLog(`delete ${sessionId} busy=${busy.busy}(${busy.detail}) resident=${resident}`)
          if (busy.busy) {
            sendJson(res, 409, { ok: false, error: '会话仍有进行中的工作，无法删除', detail: busy.detail })
            return
          }

          // 1. Real unload FIRST, while the session is proven idle. Doing it
          //    before the payload erase also lets the projection cache's
          //    mandatory "detach" checkpoint land before that record is wiped,
          //    and it closes the log writer so nothing can re-persist later.
          const unload = resident
            ? await unloadLiveSession(ctx, sessionId)
            : { unloaded: false, detail: 'not-resident' }
          await opLog(`卸载活会话: unloaded=${unload.unloaded} (${unload.detail})`)

          // 2. Registry: global archive/pin sets plus every workspace row.
          const registry = await forgetInRegistry(ctx, sessionId)
          await opLog(`registry 移除完成: workspaces=[${registry.workspaces.join('、')}] archived=${registry.archived} pinned=${registry.pinned}`)

          // 3. Durable payload: MOVE it into the recycle bin. The display title
          //    has to be read first — clearing the cache is part of the delete —
          //    and the owning workspace comes from the registry scan above.
          const title = readSessionTitle(ctx, sessionId)
          let trashed = null
          let removedPaths = []
          try {
            trashed = await moveToTrash(ctx, sessionId, {
              title,
              workspaceId: registry.owners?.[0]?.workspaceId ?? '',
              workspaceTitle: registry.owners?.[0]?.title ?? '',
              workspacePath: registry.owners?.[0]?.path ?? '',
              archived: registry.archived,
              pinned: registry.pinned,
            })
          } catch (error) {
            await opLog(`移入回收站失败，退回硬删除: ${error?.message ?? error}`)
            log(`会话移入回收站失败，退回硬删除：${sessionId}`, error)
          }
          if (trashed !== null) {
            // The cache must stop being live, or the next write-behind
            // checkpoint recreates the very document the bin just froze.
            try {
              removedPaths = await eraseProjcache(ctx, sessionId)
            } catch (error) {
              await opLog(`缓存清理失败（会话已在回收站）: ${error?.message ?? error}`)
            }
          } else {
            // Either the session never reached the disk (nothing to restore)
            // or the move failed: keep the old hard delete so the registry is
            // never left pointing at an unreadable id.
            try {
              removedPaths = await erasePayload(ctx, sessionId)
            } catch (error) {
              // Registry is already consistent; report the payload failure but
              // do not roll the sidebar removal back.
              await opLog(`载荷清理失败（注册表已移除）: ${error?.message ?? error}`)
              log(`会话载荷清理失败（注册表已移除）：${sessionId}`, error)
            }
          }

          // 4. Still resident ⇒ the unload probe failed. Degrade honestly:
          //    freeze + hide it, report that, and re-purge the cache once its
          //    pending write-behind timer has had a chance to fire.
          let hidden = false
          const live = isResident(ctx, sessionId)
          if (live) {
            try {
              hidden = await hideLiveRemnant(ctx, sessionId)
              await opLog(`活会话未卸载，降级隐藏: hidden=${hidden}`)
            } catch (error) {
              await opLog(`活会话残留隐藏失败: ${error?.message ?? error}`)
            }
            scheduleResidualPurge(ctx, sessionId)
          }
          await opLog(trashed !== null
            ? `已移入回收站 ${sessionId}（${title || '无标题'}），清理 ${removedPaths.length} 处: ${removedPaths.join(' | ')}`
            : `已硬删除会话 ${sessionId}，文件 ${removedPaths.length} 处: ${removedPaths.join(' | ')}`)
          log(`已删除会话 ${sessionId}（工作区：${registry.workspaces.join('、') || '未知'}，方式：${trashed !== null ? '回收站' : '彻底删除'}，卸载=${unload.unloaded}）`)
          sendJson(res, 200, {
            ok: true,
            ...registry,
            trashed: trashed !== null,
            trash: trashed === null ? null : {
              sessionId,
              title: trashed.title,
              workspaceDir: trashed.workspaceDir,
              bytes: trashed.bytes,
            },
            removed: removedPaths,
            live,
            unloaded: unload.unloaded,
            unloadDetail: unload.detail,
            hidden,
          })
          return
        }
        // ---- recycle bin --------------------------------------------------
        if (url.pathname === `${ROUTE_PREFIX}/trash` && req.method === 'GET') {
          const bin = await listTrash()
          sendJson(res, 200, { ok: true, ...bin })
          return
        }
        if (url.pathname === `${ROUTE_PREFIX}/trash/restore` && req.method === 'POST') {
          const body = await readJsonBody(req)
          const sessionId = body?.sessionId
          if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
            throw Object.assign(new Error('非法的 sessionId'), { statusCode: 400 })
          }
          await opLog(`restore ${sessionId}`)
          const result = await restoreFromTrash(ctx, sessionId)
          await opLog(`已恢复会话 ${result.sessionId} → ${result.workspaceDir}/${result.sessionId}，文件 ${result.restored.length} 处`)
          log(`已恢复会话 ${result.sessionId}（工作区：${result.workspace || result.workspaceDir}）`)
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        if (url.pathname === `${ROUTE_PREFIX}/trash/purge` && req.method === 'POST') {
          const body = await readJsonBody(req)
          const sessionId = body?.sessionId
          if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
            throw Object.assign(new Error('非法的 sessionId'), { statusCode: 400 })
          }
          const existed = await purgeTrashEntry(sessionId)
          await opLog(`彻底删除 ${sessionId} existed=${existed}`)
          sendJson(res, 200, { ok: true, purged: existed })
          return
        }
        // The only call that erases every binned session at once. The client
        // confirms first; there is no undo on the other side of this line.
        if (url.pathname === `${ROUTE_PREFIX}/trash/empty` && req.method === 'POST') {
          const count = await emptyTrash()
          await opLog(`清空回收站: ${count} 个条目`)
          log(`清空回收站：${count} 个条目已彻底删除`)
          sendJson(res, 200, { ok: true, count })
          return
        }
        await opLog(`404 ${req.method} ${req.url}`)
        sendJson(res, 404, { error: '未知接口' })
      } catch (error) {
        const status = Number(error?.statusCode) || 500
        await opLog(`ERROR ${req.method} ${req.url} → ${status}: ${error instanceof Error ? error.message : String(error)}\n${error instanceof Error ? error.stack : ''}`)
        log(`请求失败：${req?.url ?? ''}`, error)
        sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  log(`删除接口就绪：${ROUTE_PREFIX}/status 与 ${ROUTE_PREFIX}/delete`)
  void opLog(`plugin activated (session-delete), routes on ${ROUTE_PREFIX}`)
  // Self-heal markers left by deleting a session that was still loaded in memory.
  void pruneDanglingIds(ctx).catch((error) => opLog(`启动清理失败: ${error?.message ?? error}`))
}
