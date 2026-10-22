import { NextResponse } from "next/server";
import { getUser, type User } from "./session";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Run a route body; an HttpError becomes `{ error }` with its status, anything else is a 500. */
export async function handleRoute(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error(err);
    return NextResponse.json({ error: "error.server" }, { status: 500 });
  }
}

/** The signed-in user, or throw 401. With `roles`, also 403 unless the user's role is listed (no role = no match). */
export async function requireUser(req: Request, roles?: NonNullable<User["role"]>[]): Promise<User> {
  const user = await getUser(req);
  if (!user) throw new HttpError(401, "error.signin_required");
  if (roles && (user.role === null || !roles.includes(user.role))) throw new HttpError(403, "error.forbidden");
  return user;
}
