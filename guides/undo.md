# Undo and history

Almost anything you change in Muny can be undone: a category, a rule, a deleted account, an inbox suggestion you approved, a statement import, a change an assistant made. If something goes wrong, you can put it back.

## Undoing what you just did

Right after a change, a bar at the bottom of the page says what changed, like **Changed transaction "Corner Cafe"**, with an **Undo** button. Pressing **Ctrl+Z** (**⌘Z** on a Mac) does the same, as long as you're not typing in a field. After undoing, the bar offers **Redo**.

Arranging your Overview, switching themes and marking notifications read don't show the bar, but they're still in the history.

## The history

**Settings → History** lists every change from the last 60 days: what it was, who made it (you, someone in your household, or an assistant), when, and what it touched. **Undo** on any of them puts it back; an undone change shows **Redo**.

Undoing puts back exactly what that change touched and nothing else. If you changed a transaction's category and later added a note, undoing the category change keeps the note.

Muny asks before undoing when:

- **Something was changed since.** For example, you changed a category, then changed it again; undoing the first would overwrite the second. Muny lists what would be overwritten, and you choose.
- **More would go than the change itself.** Undoing "Added account" also removes the transactions added to that account since. Muny says how many before anything happens.

It won't undo something when putting it back would break something else, like bringing back a transaction whose account has since been removed. Undo the later change first.

## What's kept, and for how long

- Changes from the last **60 days**. Older history is removed automatically.
- Changes made through Muny's pages and by assistants. Background work, like scheduled bank syncs, isn't in the history unless you started it (pressing **Sync now** is).
- **Not kept:** passwords and sign-ins (so undo can never bring back an old password), logs, and price caches.

Things you delete stay in the history, inside your database, until they're 60 days old. To remove them sooner, the owner can press **Forget history** at the bottom of the History tab. Nothing in Muny changes; only the ability to undo goes.

---

[← All guides](README.md)
