# Recurring bills and subscriptions

**Recurring** (under Money) shows everything that repeats: subscriptions, bills and income. Muny finds them on its own from your transactions, so there's nothing to set up, only to review.

![Recurring: subscriptions and bills with what is due and what has been paid](images/recurring.png)

## How Muny finds them

Muny looks for charges from the same merchant at a steady rhythm (weekly, every two weeks, monthly, quarterly, twice a year or yearly) and at a steady or similar amount. It checks again whenever new transactions arrive, and you can press **Rescan** at any time. A series keeps its history when a merchant renames itself or your bank changes how it describes the charge.

Each series is one of three kinds:

| Kind             | What it is                                                 | Examples                                      |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------- |
| **Subscription** | A fixed price you can usually cancel online                | Streaming, software, gym, storage             |
| **Bill**         | A cost that varies, or a fixed one you can't easily cancel | Power, water, phone, insurance, loan payments |
| **Income**       | Money that arrives on a schedule                           | Paychecks, interest                           |

## Reviewing what it found

New series are marked **New**. For each one:

- **Confirm** it's real, so it counts in what's due and in your forecast.
- **Not recurring** when it isn't (several separate purchases from one shop, say). Muny won't suggest it again.

The tiles at the top add up your subscriptions and bills per month, their yearly total, and your recurring income.

## This month at a glance

Every series shows where it stands this month:

| Status                       | Meaning                                        |
| ---------------------------- | ---------------------------------------------- |
| **✓ Paid** (or **Received**) | This month's charge has arrived, with its date |
| **⏳ Pending**               | Your bank shows the charge as pending          |
| **Due**                      | Expected on the date shown                     |
| **Late**                     | The expected date has passed without a charge  |
| **Next**                     | Nothing due until a later month                |

The line above the list totals what's been paid this month, what's pending, and what's still due. **Upcoming** lists everything expected over the next 30 days, which the Overview's calendar and **Coming up** card show too, income included.

## Changing a series

Click a series to edit its name, kind, how often it repeats, its amount and category (optionally refiling its past charges), and notes. Its charges are listed underneath.

- **I cancelled it:** records the saving and marks the series cancelled. Muny confirms it when the charges stop, and alerts you if one arrives anyway.
- **Price went down:** after negotiating a bill or downgrading a plan, enter the new price to record what you're saving.
- **Price rises** are spotted on their own: the series shows **was $X**, you can get an alert, and [Ways to save](savings.md#ways-to-save) suggests asking for the old price back.

Cancelled and inactive series move to **Inactive or cancelled** at the bottom of the list.

## Keeping charges with their series when the bank renames them

Muny follows a merchant through small renames on its own, but sometimes a bank's feed changes the name completely, and a paycheck or bill stops joining its series. It then shows as late, and the month's expected income or bills count it twice.

A rule fixes that for good. Open the series and click **Add a rule for this**. The rule editor opens already filled in: the series' bank description, its direction and account, and the action **Count as recurring** pointing at the series. Adjust it if you need to, check the matching transactions in the preview, and create it. From then on, anything the rule matches belongs to that series, whatever the merchant is called. Muny applies it straight away and on every later scan. You can also add the **Count as recurring** action to any rule under **Settings → Rules**.

## Adding one by hand

For something Muny didn't spot, open one of its transactions and use **Repeats** to make it recurring, choosing how often.

## Free trials

The **Free trials** tab tracks trials before they turn into charges: what it is, when it's free until, what it costs after, and optionally how to cancel. Muny reminds you before the trial ends (see [Alerts](alerts.md)), and moves it to **Past trials** afterwards.

## Related

- [Budgets](budgets.md): bills and subscriptions feed the **Bills & subscriptions** basic and the month-end forecast.
- [Savings → Money saved](savings.md#money-saved): where cancellations and lower prices are tracked.
- [Alerts](alerts.md): bills coming due, price rises and charges after you cancel.

---

[← All guides](README.md)
