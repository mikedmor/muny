# Your Overview

The Overview is a grid of cards you can arrange however you like: 12 columns wide and as tall as you need. Each person in a household has their own layout.

## Arranging cards

Click **Customize** at the top of the page. Then:

- **Move** a card by dragging it. Other cards make room, and everything floats up to fill the gaps.
- **Resize** a card by dragging its bottom-right corner.
- **Add card** lists every card that isn't on your Overview, including **Coming up**.
- **✕** on a card removes it. You can add it back any time.

Each card also has buttons for all of this (arrows to move, ⇤ ⇥ for width, − + for height), which work from the keyboard. On a phone, cards stack in one column and the arrows reorder them.

A card starts out as tall as its content. Once you resize it, it keeps your height and scrolls if it needs to; **↕** makes it fit its content again. Cards with nothing to show (say, Crypto with no coins) take no space until they have something.

Click **Done** to save, **Cancel** to throw away your changes, or **Reset** to go back to the standard layout.

## Making your own cards

**Add card → Create a custom card** builds a card from your data: choose what to show (spending by category or merchant, totals, a month-by-month history, net worth, balances, budgets, upcoming charges or transactions), how to show it (one big number, a list, bars, columns or a line), and its options. The preview updates as you go. Custom cards are shared with everyone in your household, and each person chooses whether to put them on their own Overview.

To change or delete a custom card, click **✎** on it while customizing.

## Cards from an AI assistant

Under **Use JSON or an AI assistant** in that dialog you'll find a prompt to copy into any assistant. It describes what a card can be and contains none of your financial data. Describe the card you want, then paste the assistant's answer back in: it fills in the form so you can check the preview before saving.

A card is a definition, not a program: a data source Muny already has plus a way to show it. That's on purpose. A card can't run code or reach the internet, so a card from an assistant or a stranger can't touch your data.

## For developers

The same operations are available through the API (signed in): `GET /api/dashboard/schema` describes every card, source, view and option; `GET /api/dashboard` reads your layout and cards; `PUT /api/dashboard/layout` saves a layout; `POST /api/dashboard/preview` tries a definition without saving it; and `POST`, `PUT` and `DELETE` on `/api/dashboard/cards` manage custom cards.

To add a built-in card, add it to `BUILTIN_CARDS` in `packages/shared/src/dashboard.ts` and give it a renderer in `CARD_RENDERERS` in `apps/web/src/pages/OverviewPage.tsx`. To add a data source, add it to `CARD_SOURCES` and `CARD_SOURCE_INFO`, then handle it in `runCard` in `apps/server/src/dashboard/service.ts`.
