/* Plugin-only config the Better Auth CLI loads to generate the Drizzle schema
   (`pnpm auth:schema`). The real instance lives in src/server/auth.ts. */
import { betterAuth } from "better-auth";
import { magicLink, organization } from "better-auth/plugins";

export const auth = betterAuth({
  plugins: [organization(), magicLink({ sendMagicLink: async () => {} })],
});
