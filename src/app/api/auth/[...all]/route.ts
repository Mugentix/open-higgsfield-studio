import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/server/auth";
import { dbReady } from "@/server/db/client";

const handler = toNextJsHandler(auth);

export async function GET(request: Request) {
  await dbReady();
  return handler.GET(request);
}

export async function POST(request: Request) {
  await dbReady();
  return handler.POST(request);
}
