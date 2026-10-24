/**
 * Client half of the `dsh-session-clean` bundle.
 *
 * Registers one row in the shipped `sidebar.workspaces.session.menu.item`
 * list — the same list the built-in pin / rename / fork / archive rows live
 * in — so "Delete session" appears in every session's "…" menu at order 500
 * (after archive), including archived rows.
 *
 * The row greys itself while the session owns live work by selecting from the
 * host-provided `useSessionStatus` snapshot, the same store the sidebar's
 * "进行中" status uses. The Host re-checks before deleting, so this is
 * presentation, not enforcement.
 *
 * Structure note (the lesson from the first cut): a menu row unmounts with
 * its menu, so the confirm dialog and the result toast must NOT live inside
 * the row component. Like the shipped archive flow, they hang off the
 * frame-wide `shell.overlay` slot and talk to the row through a tiny
 * module-level request store — closing the menu cannot kill a pending dialog.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-clean',
  factory(require) {
    // Human-synced copy of package.json#version: client bundles cannot read
    // package.json at runtime. Bump together with `npm version`.
    const VERSION = '1.6.3-trash.1'

    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-session-clean'
    const DICT = {
      zh: {
        menu: '删除会话',
        menuBusy: '会话运行中，无法删除',
        confirmTitle: '删除此会话？',
        confirmDesc: '「{title}」会先移入回收站，随时可以恢复；只有回收站里的「彻底删除」才会真正清掉数据。',
        confirmNote: '运行中的会话删不了（菜单会置灰）。\n删掉你正在看的会话也可以，界面会自动切到同工作区的新会话。\n删掉的会话进「回收站」（侧栏底部），想找回就去那里恢复。',
        confirmBusy: '会话仍有进行中的工作，无法删除。',
        confirmAction: '移入回收站',
        cancel: '取消',
        deleting: '正在删除…',
        done: '已移入回收站',
        doneUnloaded: '已移入回收站：列表里不再出现，可在侧栏底部「回收站」找回',
        doneNoPayload: '会话已删除（它还没有落盘的数据，没有可恢复的内容）',
        doneLegacy: '已删除。注意：这次是彻底删除——回收站要重启 DSH 后才会启用',
        doneLive: '数据已移入回收站，但这次没能把会话彻底移出内存：先临时藏了起来（切到「显示已归档」能看到），重启 DSH 后彻底消失',
        failed: '删除失败：{message}',
        cleanupFooter: '清理分组',
        cleanupTitle: '清理会话分组',
        cleanupDesc: '选择一个分组，把它的会话全部移入回收站（可随时恢复）。含运行中会话的分组会被整批拦下。',
        cleanupEmpty: '还没有任何带会话的分组',
        cleanupCount: '{n} 个会话',
        cleanupCountTotal: '共 {n} 个会话',
        cleanupBusyTag: '{n} 个运行中',
        cleanupAction: '清空',
        cleanupConfirmTitle: '清空「{title}」的全部会话？',
        cleanupConfirmDesc: '将把该分组下的 {n} 个会话移入回收站，之后可以在那里恢复。',
        cleanupBusyBlocked: '有 {n} 个会话正在运行，已整批取消：请等它们结束再来',
        cleanupWorking: '正在删除 {done}/{total}…',
        cleanupDone: '已删除 {n} 个会话',
        cleanupPartial: '已删除 {n} 个，失败 {m} 个',
        cleanupClose: '关闭',
        cleanupActionRemove: '清空并移除分组',
        cleanupButtonHints: '「永久删除」：只删会话，分组保留\n「清空并移除分组」：会话和分组一起删',
        cleanupRemoveDone: '已清空并移除「{title}」',
        cleanupRemoveUnavailable: '当前 DSH 版本不支持移除分组，会话已清空。',
        cleanupUngrouped: '未分组',
        cleanupUngroupedHint: '不属于任何分组的会话（删掉的分组留下的、或新建时没选分组）',
        cleanupArchivedTag: '{m} 个不在列表',
        cleanupArchivedNote: '其中 {m} 个在默认视图里看不到（已归档 / 子代理等），也会一并删除。',
        trashFooter: '回收站',
        trashTitle: '回收站',
        trashDesc: '删掉的会话先放在这里，随时可以恢复。只有「彻底删除」和「清空回收站」会真的把数据清掉。',
        trashEmpty: '回收站是空的',
        trashCount: '{n} 个会话',
        trashDeletedAt: '删除于 {time}',
        trashRestore: '恢复',
        trashPurge: '彻底删除',
        trashPurgeAll: '清空回收站',
        trashNotRestorable: '这一条没有可恢复的会话数据',
        trashConfirmPurgeTitle: '彻底删除「{title}」？',
        trashConfirmPurgeDesc: '这条会话的数据会被永久删除，无法恢复。',
        trashConfirmEmptyTitle: '清空回收站？',
        trashConfirmEmptyDesc: '回收站里的 {n} 个会话会被永久删除，无法恢复。',
        trashRestored: '已恢复「{title}」',
        trashRestoredArchived: '已恢复「{title}」（原来是归档状态，仍在归档里）',
        trashRestoredMissingWorkspace: '已恢复「{title}」，但原分组已不存在，会出现在「未分组」',
        trashPurged: '已彻底删除',
        trashPurgeAllDone: '回收站已清空（{n} 个）',
        trashWorking: '正在处理…',
        trashNoop: '回收站里已经没有内容了',
        trashNeedsRestart: '回收站还没启用：请重启 DSH 后重试',
        trashFailed: '操作失败：{message}',
        trashNeedRefresh: '已恢复。若侧栏还没出现，刷新一下页面即可。',
      },
      en: {
        menu: 'Delete session',
        menuBusy: 'Session is running; deletion unavailable',
        confirmTitle: 'Delete this session?',
        confirmDesc: '“{title}” moves to the recycle bin first and can be restored at any time. Only “Delete permanently” inside the bin really erases data.',
        confirmNote: 'A running session cannot be deleted (its menu row greys out).\nDeleting the session you are viewing is fine: the view moves to a fresh session in the same workspace.\nDeleted sessions land in the recycle bin (sidebar footer) — restore them from there.',
        confirmBusy: 'The session still has work in progress and cannot be deleted.',
        confirmAction: 'Move to bin',
        cancel: 'Cancel',
        deleting: 'Deleting…',
        done: 'Moved to the recycle bin',
        doneUnloaded: 'Moved to the recycle bin: it leaves the list and can be restored from the sidebar footer',
        doneNoPayload: 'Session deleted — it had no data on disk yet, so there was nothing to keep',
        doneLegacy: 'Deleted. Note: this was a permanent delete — the recycle bin only works after a DSH restart',
        doneLive: 'The data is in the recycle bin, but the session itself could not be fully unloaded this time: it is hidden for now (visible under “show archived”) and disappears for good after a DSH restart',
        failed: 'Delete failed: {message}',
        cleanupFooter: 'Clean workspace',
        cleanupTitle: 'Clean a workspace',
        cleanupDesc: 'Pick a workspace and move all of its sessions to the recycle bin (restorable). A batch containing any running session is refused as a whole.',
        cleanupEmpty: 'No workspace has any session yet',
        cleanupCount: '{n} sessions',
        cleanupCountTotal: '{n} sessions in total',
        cleanupBusyTag: '{n} running',
        cleanupAction: 'Clean',
        cleanupConfirmTitle: 'Delete every session in “{title}”?',
        cleanupConfirmDesc: 'The {n} session(s) in that workspace move to the recycle bin and can be restored from there.',
        cleanupBusyBlocked: '{n} session(s) are running, so the whole batch was cancelled — try again once they finish',
        cleanupWorking: 'Deleting {done}/{total}…',
        cleanupDone: 'Deleted {n} session(s)',
        cleanupPartial: 'Deleted {n}, {m} failed',
        cleanupClose: 'Close',
        cleanupActionRemove: 'Clean and remove group',
        cleanupButtonHints: '“Delete permanently”: sessions only, the group stays.\n“Clean and remove group”: sessions and the group go together.',
        cleanupRemoveDone: 'Cleaned and removed “{title}”',
        cleanupRemoveUnavailable: 'This DSH build cannot unregister a workspace; the sessions were cleaned.',
        cleanupUngrouped: 'Ungrouped',
        cleanupUngroupedHint: 'Sessions no workspace owns (left by a deleted group, or started without one)',
        cleanupArchivedTag: '{m} hidden',
        cleanupArchivedNote: 'This also deletes {m} entry(ies) the default view hides (archived / subagent etc.).',
        trashFooter: 'Recycle bin',
        trashTitle: 'Recycle bin',
        trashDesc: 'Deleted sessions wait here and can be restored. Only “Delete permanently” and “Empty bin” really erase data.',
        trashEmpty: 'The recycle bin is empty',
        trashCount: '{n} session(s)',
        trashDeletedAt: 'deleted {time}',
        trashRestore: 'Restore',
        trashPurge: 'Delete permanently',
        trashPurgeAll: 'Empty bin',
        trashNotRestorable: 'This entry has no session data to restore',
        trashConfirmPurgeTitle: 'Permanently delete “{title}”?',
        trashConfirmPurgeDesc: 'That session’s data will be erased for good. It cannot be undone.',
        trashConfirmEmptyTitle: 'Empty the recycle bin?',
        trashConfirmEmptyDesc: 'The {n} session(s) in the bin will be deleted permanently. It cannot be undone.',
        trashRestored: 'Restored “{title}”',
        trashRestoredArchived: 'Restored “{title}” (it was archived, and still is)',
        trashRestoredMissingWorkspace: 'Restored “{title}”, but its workspace is gone — it will appear under Ungrouped',
        trashPurged: 'Deleted permanently',
        trashPurgeAllDone: 'Recycle bin emptied ({n})',
        trashWorking: 'Working…',
        trashNoop: 'The recycle bin is already empty',
        trashNeedsRestart: 'The recycle bin is not active yet — restart DSH and try again',
        trashFailed: 'Failed: {message}',
        trashNeedRefresh: 'Restored. If the sidebar has not caught up, reload the page.',
      },
    }

    const STYLE_ID = 'dsh-session-clean-style'

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dsh-sd-overlay { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); }
.dsh-sd-dialog { width: min(440px, calc(100vw - 48px)); border-radius: 12px; border: .5px solid var(--dsw-alias-border-l2, #333); background: var(--dsw-alias-bg-layer-2, #1f1f1f); color: var(--dsw-alias-label-primary, #eee); padding: 18px; box-shadow: 0 12px 40px rgba(0,0,0,.4); }
.dsh-sd-title { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
.dsh-sd-desc { margin: 0 0 14px; font-size: 15.5px; line-height: 23px; color: var(--dsw-alias-label-secondary, #aaa); word-break: break-all; }
.dsh-sd-note { margin: -6px 0 14px; font-size: 15px; line-height: 21px; color: var(--dsw-alias-label-secondary, #999); white-space: pre-line; }
.dsh-sd-warn { margin: 0 0 14px; font-size: 15.5px; color: var(--dsw-alias-state-error-primary, #f85149); }
.dsh-sd-footer { display: flex; justify-content: flex-end; gap: 8px; }
.dsh-sd-btn { padding: 7px 16px; border-radius: 8px; border: .5px solid var(--dsw-alias-border-l2, #444); background: transparent; color: inherit; font: inherit; font-size: 15.5px; cursor: pointer; }
.dsh-sd-btn:disabled { opacity: .55; cursor: default; }
.dsh-sd-btn[data-danger="true"] { border-color: transparent; background: var(--dsw-alias-state-error-primary, #d1242f); color: #fff; }
.dsh-sd-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 10000; padding: 10px 18px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #1f1f1f); border: .5px solid var(--dsw-alias-border-l2, #333); color: var(--dsw-alias-label-primary, #eee); font-size: 15.5px; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
.dsh-sd-toast[data-ok="false"] { color: var(--dsw-alias-state-error-primary, #f85149); }
.dsh-sd-foot { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #bbb); font: inherit; font-size: 14.5px; cursor: pointer; }
.dsh-sd-foot:hover { background: var(--dsw-alias-bg-layer-1, #2a2a2a); color: var(--dsw-alias-label-primary, #eee); }
.dsh-sd-panel { width: min(520px, calc(100vw - 48px)); max-height: min(70vh, 560px); display: flex; flex-direction: column; }
.dsh-sd-groups { overflow: auto; margin: 4px 0 12px; border-top: .5px solid var(--dsw-alias-border-l2, #333); }
.dsh-sd-group { display: flex; align-items: center; gap: 10px; padding: 9px 2px; border-bottom: .5px solid var(--dsw-alias-border-l2, #2c2c2c); }
.dsh-sd-group-main { min-width: 0; flex: 1; }
.dsh-sd-group-title { font-size: 16px; color: var(--dsw-alias-label-primary, #eee); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sd-group-meta { font-size: 14.5px; color: var(--dsw-alias-label-secondary, #999); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sd-count { font-size: 15px; color: var(--dsw-alias-label-secondary, #aaa); white-space: nowrap; }
.dsh-sd-mini { padding: 5px 12px; border-radius: 7px; border: .5px solid var(--dsw-alias-border-l2, #444); background: transparent; color: var(--dsw-alias-state-error-primary, #f85149); font: inherit; font-size: 15px; cursor: pointer; white-space: nowrap; }
.dsh-sd-mini:disabled { opacity: .45; cursor: default; color: var(--dsw-alias-label-secondary, #888); }
.dsh-sd-empty { padding: 14px 2px; color: var(--dsw-alias-label-secondary, #999); font-size: 15.5px; }
.dsh-sd-group-actions { display: inline-flex; gap: 6px; flex: none; }
.dsh-sd-ghost { color: var(--dsw-alias-label-primary, #ddd); }
`
      document.head.appendChild(style)
    }

    /**
     * Register one locale namespace and return its translator.
     * @param {object} ctx - the client plugin context.
     * @returns {(key: string, params?: object) => string} the translator.
     */
    function bindLocale(ctx) {
      ctx.locale.register(NS, 'zh', DICT.zh)
      ctx.locale.register(NS, 'en', DICT.en)
      return ctx.locale.bind(NS)
    }

    /* ------------------------------------------------------------------ *
     * Module-level request store: the menu row files a delete request here,
     * the shell.overlay occupant renders it. Outliving the menu is the
     * whole point.
     * ------------------------------------------------------------------ */

    /**
     * @typedef {{ sessionId: string, displayTitle: string, workspaceId?: string, wasOpen: boolean }} DeleteRequest
     */

    /** @type {DeleteRequest | null} */
    let pendingRequest = null
    const pendingListeners = new Set()

    /**
     * File one delete request. `workspaceId`/`wasOpen` are captured by the row
     * BEFORE the Host deletes: once the session is unloaded the main-view
     * retain count is gone, so the "was it the open one?" answer has to be
     * read on the way in, not after.
     * @param {string} sessionId - the session to delete.
     * @param {string} displayTitle - row title for the dialog.
     * @param {{ workspaceId?: string, wasOpen: boolean }} capture - pre-delete facts.
     */
    function requestDelete(sessionId, displayTitle, capture) {
      pendingRequest = { sessionId, displayTitle, ...capture }
      for (const listener of pendingListeners) listener()
    }

    function settleRequest() {
      pendingRequest = null
      for (const listener of pendingListeners) listener()
    }

    function usePendingRequest() {
      const [request, setRequest] = React.useState(pendingRequest)
      React.useEffect(() => {
        const listener = () => setRequest(pendingRequest)
        pendingListeners.add(listener)
        return () => pendingListeners.delete(listener)
      }, [])
      return request
    }

    /** Minimal trash glyph; inline so no icon package is required. */
    function TrashIcon() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true,
        style: { flex: 'none' },
      },
        h('path', {
          d: 'M6.5 2h3l.5 1h3v1.5H3V3h3l.5-1ZM4 5.5h8l-.6 8a1.5 1.5 0 0 1-1.5 1.4H6.1a1.5 1.5 0 0 1-1.5-1.4L4 5.5Z',
          fill: 'currentColor',
        }))
    }

    /**
     * The menu row: "Delete session" at order 500, shown for every session —
     * running sessions get a disabled row, archived rows stay deletable.
     * It only files a request; the dialog lives in the shell overlay.
     */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, useSessionStatus, useWorkspaces, ctx, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      const status = useSessionStatus((snapshot) =>
        snapshot instanceof Map ? snapshot.get(sessionId) : snapshot?.[sessionId],
      )
      const busy =
        status?.running === true ||
        (status?.pendingInteraction !== undefined && status?.pendingInteraction !== null)
      // Owning workspace, so the post-delete jump lands in the same group.
      const workspaceId = typeof useWorkspaces === 'function'
        ? useWorkspaces((state) => {
          const items = Array.isArray(state?.items) ? state.items : []
          return items.find((workspace) => (workspace?.sessionIds ?? []).includes(sessionId))?.workspaceId
        })
        : undefined

      /** @returns {boolean} whether the main view currently shows this session. */
      const isMainViewOpen = () => {
        try {
          const sessions = ctx?.get?.('sessions')
          const info = sessions?.retainInfo?.(sessionId)?.getSnapshot?.()
          return (info?.retainedBy?.mainView ?? 0) > 0
        } catch {
          return false
        }
      }

      return h('button', {
        type: 'button',
        role: 'menuitem',
        disabled: busy,
        title: busy ? t('menuBusy') : undefined,
        style: busy
          ? { opacity: 0.45, cursor: 'default', color: 'var(--dsw-alias-state-error-primary, #f85149)' }
          : { color: 'var(--dsw-alias-state-error-primary, #f85149)', cursor: 'pointer' },
        onClick: () => {
          if (busy) return
          setMenuOpen(false)
          requestDelete(sessionId, displayTitle, { workspaceId, wasOpen: isMainViewOpen() })
        },
      },
        h(TrashIcon),
        h('span', { style: { marginLeft: 8 } }, busy ? t('menuBusy') : t('menu')),
      )
    }

    /**
     * The shell.overlay occupant: nothing while no request is pending, then
     * one confirm dialog per request plus the result toast. Survives the
     * menu closing because this seat is frame-wide.
     */
    function DeleteSessionOverlay({ t, ctx }) {
      const request = usePendingRequest()
      const [deleting, setDeleting] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [toast, setToast] = React.useState(null)

      React.useEffect(() => {
        if (toast === null) return
        const timer = window.setTimeout(() => setToast(null), 3200)
        return () => window.clearTimeout(timer)
      }, [toast])

      // A fresh request opens with clean in-flight/error state.
      React.useEffect(() => {
        setError(null)
        setDeleting(false)
      }, [request?.sessionId])

      /**
       * Leave the dead conversation: if the session that was just deleted is
       * the one the main view was showing, start a fresh session in the same
       * workspace so the user is not left staring at a removed transcript.
       * Best effort only — a missing/failing uiWorkspace must never turn a
       * successful delete into a reported failure.
       * @param {string | undefined} workspaceId - owning workspace, when known.
       */
      const leaveDeletedConversation = (workspaceId) => {
        try {
          const uiWorkspace = ctx?.get?.('uiWorkspace')
          if (typeof uiWorkspace?.startSession !== 'function') return
          if (typeof workspaceId === 'string' && workspaceId !== '') uiWorkspace.startSession(workspaceId)
          else uiWorkspace.startSession()
        } catch {
          // Navigation is a convenience; the delete already succeeded.
        }
      }

      const callDelete = async (sessionId) => {
        setDeleting(true)
        setError(null)
        const wasOpen = pendingRequest?.wasOpen === true
        const workspaceId = pendingRequest?.workspaceId
        try {
          const response = await fetch('/_dsh-session-clean/delete', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error ?? `HTTP ${response.status}`)
          }
          // Three honest outcomes, never one blanket "deleted": the Host
          // unloaded the session for real / it stayed resident and was only
          // hidden (degraded probe) / it was already cold.
          const unloaded = payload?.unloaded === true
          const stillLive = payload?.live === true
          const trashed = payload?.trashed === true
          // An old Host half answers without `trashed` at all: that delete was
          // permanent, and saying "moved to the bin" would be a lie.
          const legacy = typeof payload?.trashed !== 'boolean'
          setToast(t(legacy ? 'doneLegacy' : !trashed ? 'doneNoPayload' : unloaded ? 'doneUnloaded' : stillLive ? 'doneLive' : 'done'))
          settleRequest()
          // Re-pull the session baseline: a *cold* delete leaves no unload
          // event behind, so without this the dead row lingers in the client
          // list (and drops into "ungrouped" once its registry slot is gone).
          // `sessions.refresh()` is the controller's single-flight
          // `session.list` pull; a failure here must not fail the delete.
          try {
            const sessions = ctx?.get?.('sessions')
            const refreshed = sessions?.refresh?.()
            if (refreshed && typeof refreshed.catch === 'function') refreshed.catch(() => {})
          } catch {
            // Refresh is a convenience; the delete already succeeded.
          }
          // Only when the main view was actually showing the deleted session
          // AND the row is really gone (a "hidden for now" session stays open).
          if (wasOpen && !stillLive) window.setTimeout(() => leaveDeletedConversation(workspaceId), 0)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setDeleting(false)
        }
      }

      return h(React.Fragment, null,
        request !== null && h('div', { className: 'dsh-sd-overlay', role: 'presentation' },
          h('div', { className: 'dsh-sd-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('confirmTitle') },
            h('h2', { className: 'dsh-sd-title' }, t('confirmTitle')),
            h('p', { className: 'dsh-sd-desc' },
              t('confirmDesc', { title: request.displayTitle || request.sessionId })),
            h('p', { className: 'dsh-sd-note' }, t('confirmNote')),
            error !== null && h('p', { className: 'dsh-sd-warn' }, t('failed', { message: error })),
            h('div', { className: 'dsh-sd-footer' },
              h('button', {
                type: 'button', className: 'dsh-sd-btn', disabled: deleting,
                onClick: () => { if (!deleting) settleRequest() },
              }, t('cancel')),
              h('button', {
                type: 'button', className: 'dsh-sd-btn', 'data-danger': true,
                disabled: deleting,
                onClick: () => { void callDelete(request.sessionId) },
              }, deleting ? t('deleting') : t('confirmAction')),
            ),
          ),
        ),
        toast !== null && h('div', { className: 'dsh-sd-toast' }, toast),
      )
    }

    /* ------------------------------------------------------------------ *
     * Group cleanup (bulk delete) + the "group I just deleted" follow-up.
     *
     * Two facts shape this design:
     *   1. This DSH version has no injectable workspace-row menu, so a
     *      "delete the whole group" action cannot sit on the group header.
     *      We also never hijack the shipped Delete-workspace dialog, whose
     *      contract is "sessions stay and move to Ungrouped".
     *   2. The shell.overlay occupant does NOT receive the workspace/status
     *      hooks (only the sidebar footer action does), so the footer action
     *      is the single producer: it publishes the live workspace list and
     *      the session statuses into a tiny module bridge, and the overlay
     *      panel is a pure consumer of that bridge.
     * ------------------------------------------------------------------ */

    const cleanupBridge = {
      /** @type {boolean} manual panel visibility */
      open: false,
      /** @type {Array<{workspaceId: string, title?: string, path?: string, sessionIds: string[]}>} */
      workspaces: [],
      /** @type {Map<string, object> | Record<string, object> | null} */
      statuses: null,
      /** @type {string[]} sessions owned by no workspace (the "Ungrouped" bucket) */
      ungroupedSessionIds: [],
    }
    const cleanupBridgeListeners = new Set()

    /** @param {Partial<typeof cleanupBridge>} patch - fields to merge. */
    function publishCleanup(patch) {
      Object.assign(cleanupBridge, patch)
      for (const listener of cleanupBridgeListeners) listener()
    }

    function useCleanupBridge() {
      const [value, setValue] = React.useState(cleanupBridge)
      React.useEffect(() => {
        const listener = () => setValue({ ...cleanupBridge })
        cleanupBridgeListeners.add(listener)
        return () => cleanupBridgeListeners.delete(listener)
      }, [])
      return value
    }

    /** Minimal broom glyph; inline so no icon package is required. */
    function BroomIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true,
        style: { flex: 'none' },
      },
        h('path', {
          d: 'M9.6 1.7 14.3 6.4 12.6 8.1 7.9 3.4 9.6 1.7ZM6.9 4.4l4.7 4.7-1.2 1.2-1.2-.3-3.5 3.5c-.9.9-2.4.9-3.3 0-.9-.9-.9-2.4 0-3.3l3.5-3.5-.3-1.2 1.3-1.1Z',
          fill: 'currentColor',
        }))
    }

    /**
     * Sidebar-footer action. It is the only seat with the workspace/status
     * hooks, so it (a) opens the manual panel, (b) publishes the data that
     * panel renders, and (c) notices a workspace that disappeared and files
     * the "clean the spilled sessions?" follow-up.
     */
    function CleanupFooterAction({ wide, useWorkspaces, useSessionStatus, useSessions, ctx, t }) {
      const workspaces = useWorkspaces((state) => (Array.isArray(state?.items) ? state.items : []))
      const archivedSessionIds = useWorkspaces((state) => state?.archivedSessionIds)
      const archivedSet = new Set(Array.isArray(archivedSessionIds) ? archivedSessionIds : [])
      const statuses = useSessionStatus((snapshot) => snapshot)
      const summaries = typeof useSessions === 'function'
        ? useSessions((state) => state?.byId)
        : undefined
      // Sessions owned by no workspace are what the sidebar shows as
      // "Ungrouped"; subagent children never belong in that bucket.
      const owned = new Set()
      for (const workspace of workspaces) for (const id of workspace?.sessionIds ?? []) owned.add(id)
      const ungroupedSessionIds = Object.values(summaries ?? {})
        .filter((summary) => summary !== null && typeof summary === 'object' &&
          summary.origin !== 'subagent' && owned.has(summary.sessionId) === false)
        .map((summary) => summary.sessionId)
      /** @param {string} sessionId - id to classify. @returns {boolean} hidden inside a workspace row. */
      const isArchived = (sessionId) => archivedSet.has(sessionId)
      /** @param {string} sessionId - id to classify. @returns {boolean} a subagent child, not a user row. */
      const isSubagent = (sessionId) => summaries?.[sessionId]?.origin === 'subagent'
      /** @param {string[]} sessionIds - a group's members. @returns {{visible: number, archived: number}} */
      const splitCount = (sessionIds) => {
        let visible = 0
        let archived = 0
        for (const sessionId of sessionIds) {
          if (isArchived(sessionId)) archived += 1
          else if (isSubagent(sessionId)) archived += 1
          else visible += 1
        }
        return { visible, archived }
      }
      const ungroupedSplit = splitCount(ungroupedSessionIds)
      const total = workspaces.reduce((count, workspace) => count + (workspace?.sessionIds?.length ?? 0), 0) +
        ungroupedSessionIds.length

      // Publish the live view for the overlay panel (it has no hooks).
      React.useEffect(() => {
        publishCleanup({
          workspaces: workspaces.map((workspace) => {
            const sessionIds = [...(workspace.sessionIds ?? [])]
            return {
              workspaceId: workspace.workspaceId,
              title: workspace.title,
              path: workspace.path,
              sessionIds,
              ...splitCount(sessionIds),
            }
          }),
          statuses,
          ungroupedSessionIds,
          ungroupedVisible: ungroupedSplit.visible,
          ungroupedArchived: ungroupedSplit.archived,
        })
      }, [workspaces, statuses, summaries])

      if (total === 0) return null
      return h('button', {
        type: 'button',
        className: 'dsh-sd-foot',
        title: t('cleanupFooter'),
        'aria-label': t('cleanupFooter'),
        onClick: () => publishCleanup({ open: true }),
      },
        h(BroomIcon),
        wide ? h('span', null, t('cleanupFooter')) : null,
      )
    }

    /**
     * Overlay side of the group cleanup: the manual group list, the
     * "the group you deleted left N sessions behind" follow-up, one shared
     * serial runner (with the whole-batch idle gate), and the result toast.
     */
    function CleanupPanel({ t, ctx }) {
      const bridge = useCleanupBridge()
      const [target, setTarget] = React.useState(null)
      const [progress, setProgress] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [toast, setToast] = React.useState(null)

      React.useEffect(() => {
        if (toast === null) return
        const timer = window.setTimeout(() => setToast(null), 3600)
        return () => window.clearTimeout(timer)
      }, [toast])

      React.useEffect(() => {
        if (!bridge.open) {
          setTarget(null)
          setProgress(null)
          setError(null)
        }
      }, [bridge.open])

      /** @param {string} sessionId - id to classify. @returns {boolean} busy. */
      const isBusy = (sessionId) => {
        const statuses = bridge.statuses
        const status = statuses instanceof Map ? statuses.get(sessionId) : statuses?.[sessionId]
        return status?.running === true ||
          (status?.pendingInteraction !== undefined && status?.pendingInteraction !== null)
      }

      /** Refresh the client session list so deleted rows cannot linger. */
      const refreshSessions = () => {
        try {
          const sessions = ctx?.get?.('sessions')
          const refreshed = sessions?.refresh?.()
          if (refreshed && typeof refreshed.catch === 'function') refreshed.catch(() => {})
        } catch {
          // Refresh is a convenience.
        }
      }

      /**
       * Land in the first remaining workspace after its group got deleted.
       * `openWorkspace` reuses/creates a blank session there and switches the
       * main view, which is what "进入第一个还活着的分组" means.
       * @param {string} removedWorkspaceId - the group that just vanished.
       */
      const openFirstAliveWorkspace = (removedWorkspaceId) => {
        const alive = (bridge.workspaces ?? []).filter((workspace) => workspace.workspaceId !== removedWorkspaceId)
        const first = alive[0]
        if (first === undefined) return
        try {
          const uiWorkspace = ctx?.get?.('uiWorkspace')
          if (typeof uiWorkspace?.openWorkspace === 'function') uiWorkspace.openWorkspace(first.workspaceId)
        } catch {
          // Navigation is best effort.
        }
      }

      /**
       * Delete one batch serially behind the whole-batch idle gate.
       * @param {string[]} sessionIds - every member to delete.
       * @returns {Promise<{ok: number, failed: number, openDeleted: boolean} | null>} null when refused.
       */
      const deleteBatch = async (sessionIds) => {
        setError(null)
        // Read the main-view retain counts BEFORE deleting: an unload clears
        // them, so afterwards there is no way to tell whether the conversation
        // on screen was part of this batch.
        const openDeleted = sessionIds.some((sessionId) => {
          try {
            const sessions = ctx?.get?.('sessions')
            return (sessions?.retainInfo?.(sessionId)?.getSnapshot?.()?.retainedBy?.mainView ?? 0) > 0
          } catch {
            return false
          }
        })
        try {
          const query = sessionIds.map((sessionId) => encodeURIComponent(sessionId)).join(',')
          const precheck = await fetch(`/_dsh-session-clean/precheck?sessionIds=${query}`, {
            credentials: 'same-origin',
          }).then((response) => response.json()).catch(() => ({}))
          if (precheck?.ok !== true) {
            const busy = Array.isArray(precheck?.busy) ? precheck.busy.length : sessionIds.length
            setError(t('cleanupBusyBlocked', { n: busy }))
            return null
          }
          let ok = 0
          let failed = 0
          setProgress({ done: 0, total: sessionIds.length })
          for (let index = 0; index < sessionIds.length; index += 1) {
            try {
              const response = await fetch('/_dsh-session-clean/delete', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId: sessionIds[index] }),
              })
              const payload = await response.json().catch(() => ({}))
              if (response.ok && payload?.ok === true) ok += 1
              else failed += 1
            } catch {
              failed += 1
            }
            setProgress({ done: index + 1, total: sessionIds.length })
          }
          refreshSessions()
          setProgress(null)
          setToast(failed === 0 ? t('cleanupDone', { n: ok }) : t('cleanupPartial', { n: ok, m: failed }))
          return { ok, failed, openDeleted }
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
          setProgress(null)
          return null
        }
      }

      /** Manual panel: clean one live workspace. */
      const cleanWorkspace = async (workspace) => {
        const result = await deleteBatch([...(workspace?.sessionIds ?? [])])
        if (result === null) return
        setTarget(null)
        if (result.failed === 0) publishCleanup({ open: false })
        // The workspace still exists, so land in a fresh session of it rather
        // than staying on the transcript we just deleted.
        if (result.openDeleted) {
          try {
            const uiWorkspace = ctx?.get?.('uiWorkspace')
            if (typeof uiWorkspace?.startSession === 'function') uiWorkspace.startSession(workspace.workspaceId)
          } catch {
            // Navigation is best effort.
          }
        }
      }

      /**
       * Manual panel: clean the Ungrouped bucket (sessions no workspace owns).
       * There is no workspace to land in, so the view falls back to the first
       * remaining workspace.
       */
      const cleanUngrouped = async (sessionIds) => {
        const result = await deleteBatch([...sessionIds])
        if (result === null) return
        setTarget(null)
        if (result.failed === 0) publishCleanup({ open: false })
        if (result.openDeleted) openFirstAliveWorkspace('')
      }

      /**
       * Clean one workspace AND unregister the group in one pass — the panel's
       * "thorough" action. The group removal reuses the shipped
       * workspaces.delete, so the sidebar bookkeeping is exactly what the
       * official action would have done; the difference is that the sessions
       * are gone first instead of spilling into Ungrouped.
       * @param {{workspaceId: string, title?: string, path?: string, sessionIds: string[]}} workspace - target group.
       */
      const cleanWorkspaceAndRemove = async (workspace) => {
        const result = await deleteBatch([...(workspace?.sessionIds ?? [])])
        if (result === null) return
        let removed = false
        try {
          const workspaces = ctx?.get?.('workspaces')
          if (typeof workspaces?.delete === 'function') {
            await workspaces.delete(workspace.workspaceId)
            removed = true
          } else {
            setError(t('cleanupRemoveUnavailable'))
          }
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
        setTarget(null)
        if (removed) {
          publishCleanup({ open: false })
          setToast(t('cleanupRemoveDone', { title: workspace.title || workspace.path || workspace.workspaceId }))
        }
        if (result.openDeleted || removed) openFirstAliveWorkspace(workspace.workspaceId)
      }

      const groups = (bridge.workspaces ?? []).filter((workspace) => (workspace?.sessionIds?.length ?? 0) > 0)
      const ungroupedIds = (bridge.ungroupedSessionIds ?? []).filter((sessionId) => typeof sessionId === 'string')
      const showUngrouped = ungroupedIds.length > 0
      const toastNode = toast !== null ? h('div', { className: 'dsh-sd-toast' }, toast) : null

      if (!bridge.open) return toastNode

      return h(React.Fragment, null,
        h('div', { className: 'dsh-sd-overlay', role: 'presentation' },
          h('div', {
            className: 'dsh-sd-dialog dsh-sd-panel',
            role: 'dialog', 'aria-modal': true, 'aria-label': t('cleanupTitle'),
          },
            target === null
              ? h(React.Fragment, null,
                h('h2', { className: 'dsh-sd-title' }, t('cleanupTitle')),
                h('p', { className: 'dsh-sd-desc' }, t('cleanupDesc')),
                progress !== null ? h('p', { className: 'dsh-sd-note' }, t('cleanupWorking', progress)) : null,
                error !== null ? h('p', { className: 'dsh-sd-warn' }, error) : null,
                h('div', { className: 'dsh-sd-groups' },
                  groups.length === 0
                    ? h('div', { className: 'dsh-sd-empty' }, t('cleanupEmpty'))
                    : groups.map((workspace) => {
                      const count = workspace?.sessionIds?.length ?? 0
                      const busy = (workspace?.sessionIds ?? []).filter(isBusy).length
                      return h('div', { className: 'dsh-sd-group', key: workspace.workspaceId },
                        h('div', { className: 'dsh-sd-group-main' },
                          h('div', { className: 'dsh-sd-group-title' }, workspace.title || workspace.path || workspace.workspaceId),
                          h('div', { className: 'dsh-sd-group-meta' }, workspace.path ?? ''),
                        ),
                        h('span', { className: 'dsh-sd-count' },
                          // Hidden members are part of the batch the dialog
                          // will delete, so spell out the total instead of
                          // showing "0 sessions" for an archive-only group.
                          (workspace.archived ?? 0) > 0
                            ? t('cleanupCountTotal', { n: count })
                            : t('cleanupCount', { n: workspace.visible ?? count }),
                          (workspace.archived ?? 0) > 0
                            ? ` · ${t('cleanupArchivedTag', { m: workspace.archived })}`
                            : '',
                          busy > 0 ? ` · ${t('cleanupBusyTag', { n: busy })}` : ''),
                        h('button', {
                          type: 'button',
                          className: 'dsh-sd-mini',
                          disabled: busy > 0 || progress !== null,
                          title: busy > 0 ? t('cleanupBusyBlocked', { n: busy }) : undefined,
                          onClick: () => { setError(null); setTarget(workspace) },
                        }, t('cleanupAction')),
                      )
                    }),
                ),
                // "Ungrouped" is a sidebar bucket, not a workspace: sessions
                // spilled from a deleted group (or created outside any
                // workspace) live there and nothing else can clear them.
                showUngrouped
                  ? h('div', { className: 'dsh-sd-groups' },
                    h('div', { className: 'dsh-sd-group', key: 'dsh-sd-ungrouped' },
                      h('div', { className: 'dsh-sd-group-main' },
                        h('div', { className: 'dsh-sd-group-title' }, t('cleanupUngrouped')),
                        h('div', { className: 'dsh-sd-group-meta' }, t('cleanupUngroupedHint')),
                      ),
                      h('span', { className: 'dsh-sd-count' },
                        (bridge.ungroupedArchived ?? 0) > 0
                          ? t('cleanupCountTotal', { n: ungroupedIds.length })
                          : t('cleanupCount', { n: bridge.ungroupedVisible ?? ungroupedIds.length }),
                        (bridge.ungroupedArchived ?? 0) > 0
                          ? ` · ${t('cleanupArchivedTag', { m: bridge.ungroupedArchived })}`
                          : '',
                        (() => {
                          const busy = ungroupedIds.filter(isBusy).length
                          return busy > 0 ? ` · ${t('cleanupBusyTag', { n: busy })}` : ''
                        })()),
                      h('button', {
                        type: 'button',
                        className: 'dsh-sd-mini',
                        disabled: ungroupedIds.filter(isBusy).length > 0 || progress !== null,
                        title: ungroupedIds.filter(isBusy).length > 0
                          ? t('cleanupBusyBlocked', { n: ungroupedIds.filter(isBusy).length })
                          : undefined,
                        onClick: () => {
                          setError(null)
                          setTarget({ ungrouped: true, title: t('cleanupUngrouped'), sessionIds: ungroupedIds })
                        },
                      }, t('cleanupAction')),
                    ),
                  )
                  : null,
                h('div', { className: 'dsh-sd-footer' },
                  h('button', {
                    type: 'button', className: 'dsh-sd-btn',
                    onClick: () => publishCleanup({ open: false }),
                  }, t('cleanupClose')),
                ),
              )
              : h(React.Fragment, null,
                h('h2', { className: 'dsh-sd-title' },
                  t('cleanupConfirmTitle', { title: target.title || target.path || target.workspaceId || '' })),
                h('p', { className: 'dsh-sd-desc' }, t('cleanupConfirmDesc', { n: target?.sessionIds?.length ?? 0 })),
                target?.ungrouped === true
                  ? ((bridge.ungroupedArchived ?? 0) > 0
                    ? h('p', { className: 'dsh-sd-note' }, t('cleanupArchivedNote', { m: bridge.ungroupedArchived }))
                    : null)
                  : ((target?.archived ?? 0) > 0
                    ? h('p', { className: 'dsh-sd-note' }, t('cleanupArchivedNote', { m: target.archived }))
                    : null),
                progress !== null ? h('p', { className: 'dsh-sd-note' }, t('cleanupWorking', progress)) : null,
                error !== null ? h('p', { className: 'dsh-sd-warn' }, error) : null,
                target?.ungrouped === true
                  ? null
                  : h('p', { className: 'dsh-sd-note' }, t('cleanupButtonHints')),
                h('div', { className: 'dsh-sd-footer' },
                  h('button', {
                    type: 'button', className: 'dsh-sd-btn', disabled: progress !== null,
                    onClick: () => { if (progress === null) { setTarget(null); setError(null) } },
                  }, t('cancel')),
                  target?.ungrouped === true
                    ? null
                    : h('button', {
                      type: 'button', className: 'dsh-sd-btn', disabled: progress !== null,
                      onClick: () => { if (progress === null) void cleanWorkspaceAndRemove(target) },
                    }, progress !== null ? t('deleting') : t('cleanupActionRemove')),
                  h('button', {
                    type: 'button', className: 'dsh-sd-btn', 'data-danger': true, disabled: progress !== null,
                    onClick: () => {
                      if (progress !== null) return
                      if (target?.ungrouped === true) void cleanUngrouped(target.sessionIds ?? [])
                      else void cleanWorkspace(target)
                    },
                  }, progress !== null ? t('deleting') : t('confirmAction')),
                ),
              ),
          ),
        ),
        toastNode,
      )
    }

    /* ------------------------------------------------------------------ *
     * Recycle bin (this fork's addition).
     *
     * Deletion is no longer a one-way door: the Host moves the session's
     * directory into `$DSH_HOME/session-trash/` and this panel is the way
     * back. It is deliberately a separate overlay cell (order 20, above the
     * group-cleanup panel at 10) with its own module-level open flag, so the
     * two panels can never fight over the same state.
     *
     * The panel needs no workspace/status hooks — the Host is the single
     * source of truth for what is binned — so it simply pulls
     * `GET /_dsh-session-clean/trash` whenever it opens.
     * ------------------------------------------------------------------ */

    const trashBridge = { open: false }
    const trashListeners = new Set()

    /** @param {Partial<typeof trashBridge>} patch - fields to merge. */
    function publishTrash(patch) {
      Object.assign(trashBridge, patch)
      for (const listener of trashListeners) listener()
    }

    function useTrashBridge() {
      const [value, setValue] = React.useState(trashBridge)
      React.useEffect(() => {
        const listener = () => setValue({ ...trashBridge })
        trashListeners.add(listener)
        return () => trashListeners.delete(listener)
      }, [])
      return value
    }

    /** @param {number} bytes - a byte count. @returns {string} a short human size. */
    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
      return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
    }

    /** @param {string} iso - an ISO timestamp. @returns {string} a local-time label. */
    function formatWhen(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      try {
        return new Date(iso).toLocaleString()
      } catch {
        return iso
      }
    }

    /** Sidebar-footer entry point. It only opens the panel; the panel fetches. */
    function TrashFooterAction({ wide, t }) {
      return h('button', {
        type: 'button',
        className: 'dsh-sd-foot',
        title: t('trashFooter'),
        'aria-label': t('trashFooter'),
        onClick: () => publishTrash({ open: true }),
      },
        h(TrashIcon),
        wide ? h('span', null, t('trashFooter')) : null,
      )
    }

    /**
     * The bin itself: list one row per binned session, restore it, purge it, or
     * empty the whole bin. Every destructive step goes through one confirm
     * screen first; restoring has no confirmation because it is the safe side.
     */
    function TrashPanel({ t, ctx }) {
      const bridge = useTrashBridge()
      const [entries, setEntries] = React.useState([])
      const [loading, setLoading] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState(null)
      const [confirm, setConfirm] = React.useState(null)
      const [toast, setToast] = React.useState(null)

      React.useEffect(() => {
        if (toast === null) return
        const timer = window.setTimeout(() => setToast(null), 3600)
        return () => window.clearTimeout(timer)
      }, [toast])

      const load = async () => {
        setLoading(true)
        setError(null)
        try {
          const response = await fetch('/_dsh-session-clean/trash', { credentials: 'same-origin' })
          if (response.status === 404) throw new Error(t('trashNeedsRestart'))
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          setEntries(Array.isArray(payload.entries) ? payload.entries : [])
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setLoading(false)
        }
      }

      // Pull a fresh bin every time the panel opens: another tab (or the
      // previous session) may have changed it.
      React.useEffect(() => {
        if (!bridge.open) {
          setConfirm(null)
          return
        }
        void load()
      }, [bridge.open])

      /** Ask the client session list to re-pull the persisted corpus. */
      const refreshSessions = () => {
        try {
          const sessions = ctx?.get?.('sessions')
          const refreshed = sessions?.refresh?.()
          if (refreshed && typeof refreshed.catch === 'function') refreshed.catch(() => {})
        } catch {
          // Refresh is a convenience; the restore already succeeded on disk.
        }
      }

      const restore = async (entry) => {
        if (busy !== '') return
        setBusy(entry.sessionId)
        setError(null)
        try {
          const response = await fetch('/_dsh-session-clean/trash/restore', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: entry.sessionId }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          const title = payload.title || entry.title || entry.sessionId
          // `attached` is what the Host's registry actually did: only a real
          // attachSession survives a reconnect. Anything else lands under
          // Ungrouped and the user gets told so.
          const archived = payload.archived === true
          const grouped = payload.attached === true
          setToast(t(
            archived
              ? 'trashRestoredArchived'
              : grouped
                ? 'trashRestored'
                : 'trashRestoredMissingWorkspace',
            { title },
          ))
          setEntries((previous) => previous.filter((item) => item.sessionId !== entry.sessionId))
          refreshSessions()
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy('')
        }
      }

      const purge = async (entry) => {
        setBusy(entry.sessionId)
        setError(null)
        try {
          const response = await fetch('/_dsh-session-clean/trash/purge', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: entry.sessionId }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          setEntries((previous) => previous.filter((item) => item.sessionId !== entry.sessionId))
          setConfirm(null)
          setToast(t('trashPurged'))
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy('')
        }
      }

      const empty = async () => {
        setBusy('*')
        setError(null)
        try {
          const response = await fetch('/_dsh-session-clean/trash/empty', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          setEntries([])
          setConfirm(null)
          setToast(Number(payload.count) > 0 ? t('trashPurgeAllDone', { n: payload.count }) : t('trashNoop'))
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy('')
        }
      }

      const toastNode = toast !== null ? h('div', { className: 'dsh-sd-toast' }, toast) : null
      if (!bridge.open) return toastNode

      // Step 2: one confirm screen, shared by "purge one" and "empty bin".
      if (confirm !== null) {
        const isEmpty = confirm.kind === 'empty'
        const heading = isEmpty
          ? t('trashConfirmEmptyTitle')
          : t('trashConfirmPurgeTitle', { title: confirm.entry?.title || confirm.entry?.sessionId || '' })
        const description = isEmpty
          ? t('trashConfirmEmptyDesc', { n: entries.length })
          : t('trashConfirmPurgeDesc')
        return h(React.Fragment, null,
          h('div', { className: 'dsh-sd-overlay', role: 'presentation' },
            h('div', { className: 'dsh-sd-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': heading },
              h('h2', { className: 'dsh-sd-title' }, heading),
              h('p', { className: 'dsh-sd-desc' }, description),
              error !== null ? h('p', { className: 'dsh-sd-warn' }, t('trashFailed', { message: error })) : null,
              h('div', { className: 'dsh-sd-footer' },
                h('button', {
                  type: 'button', className: 'dsh-sd-btn', disabled: busy !== '',
                  onClick: () => { if (busy === '') { setConfirm(null); setError(null) } },
                }, t('cancel')),
                h('button', {
                  type: 'button', className: 'dsh-sd-btn', 'data-danger': true, disabled: busy !== '',
                  onClick: () => {
                    if (busy !== '') return
                    if (isEmpty) void empty()
                    else void purge(confirm.entry)
                  },
                }, busy !== '' ? t('trashWorking') : t('trashPurge')),
              ),
            ),
          ),
          toastNode,
        )
      }

      // Step 1: the list.
      return h(React.Fragment, null,
        h('div', { className: 'dsh-sd-overlay', role: 'presentation' },
          h('div', {
            className: 'dsh-sd-dialog dsh-sd-panel',
            role: 'dialog', 'aria-modal': true, 'aria-label': t('trashTitle'),
          },
            h('h2', { className: 'dsh-sd-title' },
              entries.length > 0
                ? `${t('trashTitle')} · ${t('trashCount', { n: entries.length })} · ${formatBytes(entries.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0))}`
                : t('trashTitle')),
            h('p', { className: 'dsh-sd-desc' }, t('trashDesc')),
            error !== null ? h('p', { className: 'dsh-sd-warn' }, t('trashFailed', { message: error })) : null,
            h('div', { className: 'dsh-sd-groups' },
              loading && entries.length === 0
                ? h('div', { className: 'dsh-sd-empty' }, t('trashWorking'))
                : entries.length === 0
                  ? h('div', { className: 'dsh-sd-empty' }, t('trashEmpty'))
                  : entries.map((entry) => h('div', { className: 'dsh-sd-group', key: entry.sessionId },
                    h('div', { className: 'dsh-sd-group-main' },
                      h('div', { className: 'dsh-sd-group-title' }, entry.title || entry.sessionId),
                      h('div', { className: 'dsh-sd-group-meta' },
                        [
                          entry.workspaceTitle || entry.workspacePath || t('cleanupUngrouped'),
                          entry.deletedAt ? t('trashDeletedAt', { time: formatWhen(entry.deletedAt) }) : '',
                          formatBytes(entry.bytes),
                        ].filter((part) => typeof part === 'string' && part !== '').join(' · ')),
                    ),
                    h('div', { className: 'dsh-sd-group-actions' },
                      h('button', {
                        type: 'button',
                        className: 'dsh-sd-mini dsh-sd-ghost',
                        disabled: busy !== '' || entry.restorable === false,
                        title: entry.restorable === false ? t('trashNotRestorable') : undefined,
                        onClick: () => { if (busy === '') void restore(entry) },
                      }, t('trashRestore')),
                      h('button', {
                        type: 'button',
                        className: 'dsh-sd-mini',
                        disabled: busy !== '',
                        onClick: () => {
                          if (busy !== '') return
                          setError(null)
                          setConfirm({ kind: 'purge', entry })
                        },
                      }, t('trashPurge')),
                    ),
                  )),
            ),
            h('div', { className: 'dsh-sd-footer' },
              h('button', {
                type: 'button',
                className: 'dsh-sd-btn',
                disabled: busy !== '' || entries.length === 0,
                onClick: () => {
                  if (busy !== '' || entries.length === 0) return
                  setError(null)
                  setConfirm({ kind: 'empty' })
                },
              }, t('trashPurgeAll')),
              h('button', {
                type: 'button', className: 'dsh-sd-btn', disabled: busy !== '',
                onClick: () => { if (busy === '') publishTrash({ open: false }) },
              }, t('cleanupClose')),
            ),
          ),
        ),
        toastNode,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyles()
        const t = bindLocale(ctx)

        // The stylesheet has to go away with the plugin (same contract the
        // shipped checkers enforce on every dynamic client half).
        ctx.effect(() => () => {
          document.getElementById(STYLE_ID)?.remove()
        })

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'dsh-session-clean', order: 20, label: () => t('cleanupFooter') },
            (props) => h(CleanupFooterAction, { ...props, t }),
          ),
        )

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'dsh-session-clean', order: 500 },
            (props) => h(DeleteSessionMenuItem, { ...props, ctx, t }),
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-session-clean' },
            () => h(DeleteSessionOverlay, { t, ctx }),
          ),
        )

        // Cleanup panel rides its own overlay cell (order 10) so it sits above
        // the per-session dialog layer and reads as a separate surface.
        // NOTE: the owner passes the standard hooks (`useWorkspaces`,
        // `useSessionStatus`, …) as props — they must be forwarded.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-session-clean-cleanup', order: 10 },
            (props) => h(CleanupPanel, { ...props, t, ctx }),
          ),
        )

        // Recycle bin: its own footer entry (order 30, after "Clean workspace"
        // at 20) and its own overlay cell above the cleanup panel.
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'dsh-session-clean-trash', order: 30, label: () => t('trashFooter') },
            (props) => h(TrashFooterAction, { ...props, t }),
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-session-clean-trash', order: 20 },
            (props) => h(TrashPanel, { ...props, t, ctx }),
          ),
        )
      },
    }
  },
})
