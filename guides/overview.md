# Your Overview

The Overview shows your cards in as many columns as your screen has room for: one on a phone, two on a laptop, and three or four on wide monitors. You choose which cards appear and their priority; Muny arranges them. Each person in a household has their own.

## Choosing and ordering cards

Click **Customize** at the top of the page.

- **Drag a card** by its handle (⠿) to change its priority. Higher in the list means higher on the page. Hovering a row also shows arrows, which work from the keyboard too.
- **✕** takes a card off your Overview. It moves to **Add a card**, so you can bring it back any time.
- **Add a card** lists everything that isn't on your Overview, including **Coming up**.

Click **Done** to save, **Cancel** to throw away your changes, or **Reset to standard** to go back to the standard Overview.

Charts go in the wider columns, filling whichever column is shortest, and lists and balances go in the column on the right. On a wide screen, when the lists would make that column much longer than the others, your lowest-priority ones move into the shorter columns. On a phone, everything is one column in exactly your order. Cards with nothing to show (say, Crypto with no coins) take no space until they have something.

## Making your own cards

**Customize → Create a custom card** builds a card from your data: choose what to show (spending by category or merchant, totals, a month-by-month history, net worth, balances, budgets, upcoming charges or transactions), how to show it (one big number, a list, bars, columns or a line), and its options. The preview updates as you go. Custom cards are shared with everyone in your household, and each person chooses whether to put them on their own Overview.

To change or delete a custom card, click **✎** next to it in **Customize**.

## Cards from an AI assistant

Under **Use JSON or an AI assistant** in that dialog you'll find a prompt to copy into any assistant. It describes what a card can be and contains none of your financial data. Describe the card you want, then paste the assistant's answer back in: it fills in the form so you can check the preview before saving.

A card is a definition, not a program: a data source Muny already has plus a way to show it. That's on purpose. A card can't run code or reach the internet, so a card from an assistant or a stranger can't touch your data.

## For developers

The same operations are available through the API (signed in): `GET /api/dashboard/schema` describes every card, source, view and option; `GET /api/dashboard` reads your cards; `PUT /api/dashboard/layout` saves their order (`{ "cards": ["spending", "custom:…"] }`); `POST /api/dashboard/preview` tries a definition without saving it; and `POST`, `PUT` and `DELETE` on `/api/dashboard/cards` manage custom cards.

To add a built-in card, add it to `BUILTIN_CARDS` in `packages/shared/src/dashboard.ts` and give it a renderer in `CARD_RENDERERS` in `apps/web/src/pages/OverviewPage.tsx`. To add a data source, add it to `CARD_SOURCES` and `CARD_SOURCE_INFO`, then handle it in `runCard` in `apps/server/src/dashboard/service.ts`.
