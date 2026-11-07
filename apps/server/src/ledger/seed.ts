import { type MunyDb, newId, schema } from "@muny/db";
import { DEFAULT_BILL_CATEGORIES, DEFAULT_CATEGORIES } from "@muny/shared";
import { count, eq } from "drizzle-orm";

const SEEDED_FLAG = "seed.default_categories";

/**
 * Create the default category set once per installation. Runs after owner
 * setup and on startup (for installs created before seeding existed). A flag
 * in app_settings ensures deleting categories later doesn't bring them back.
 */
export function seedDefaultCategories(db: MunyDb): boolean {
  return db.transaction((tx) => {
    const flag = tx
      .select()
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, SEEDED_FLAG))
      .get();
    if (flag) return false;
    const users = tx.select({ n: count() }).from(schema.users).get()?.n ?? 0;
    if (users === 0) return false; // wait for first-run setup
    const existing = tx.select({ n: count() }).from(schema.categoryGroups).get()?.n ?? 0;
    if (existing === 0) {
      DEFAULT_CATEGORIES.forEach((g, gi) => {
        const groupId = newId();
        tx.insert(schema.categoryGroups)
          .values({ id: groupId, name: g.group, kind: g.kind, sortOrder: gi })
          .run();
        g.categories.forEach((name, ci) => {
          tx.insert(schema.categories)
            .values({
              id: newId(),
              groupId,
              name,
              sortOrder: ci,
              isBill: DEFAULT_BILL_CATEGORIES.includes(name),
            })
            .run();
        });
      });
    }
    tx.insert(schema.appSettings)
      .values({ key: SEEDED_FLAG, value: { at: new Date().toISOString() } })
      .run();
    return existing === 0;
  });
}
