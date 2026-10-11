import { relations } from "drizzle-orm";

import { organization, user } from "./auth";
import { assets, products, projects, results, runs } from "./app";

/* Relational queries the studio makes: a run with its tiles, a project with
   its product, a result back to its run. */
export const runsRelations = relations(runs, ({ one, many }) => ({
  results: many(results),
  project: one(projects, { fields: [runs.projectId], references: [projects.id] }),
  product: one(products, { fields: [runs.productId], references: [products.id] }),
  team: one(organization, { fields: [runs.teamId], references: [organization.id] }),
  author: one(user, { fields: [runs.userId], references: [user.id] }),
}));

export const resultsRelations = relations(results, ({ one }) => ({
  run: one(runs, { fields: [results.runId], references: [runs.id] }),
  author: one(user, { fields: [results.userId], references: [user.id] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  product: one(products, { fields: [projects.productId], references: [products.id] }),
  runs: many(runs),
}));

export const productsRelations = relations(products, ({ many }) => ({
  projects: many(projects),
}));

export const assetsRelations = relations(assets, ({ one }) => ({
  product: one(products, { fields: [assets.productId], references: [products.id] }),
}));
