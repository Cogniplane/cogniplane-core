/**
 * The workspace link that the error pages use to leave a session that fails
 * to render. The workspace (`useSessionList` with URL sync) removes the
 * parameter, restores no session, and opens New session.
 */
export const NEW_SESSION_PARAM = "newSession";

export const NEW_SESSION_HREF = `/?${NEW_SESSION_PARAM}=1`;
