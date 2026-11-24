import { redactUrl } from './fetch-outcome';

// Engine error types. Electron-free so the pure engine modules (and their node:test tests) can import them.
export class SessionExpired extends Error {
  constructor(url?: string) {
    super(`Lemida session expired (hit ${url ? redactUrl(url) : 'a login/bot page'})`);
    this.name = 'SessionExpired';
  }
}

/** Signed in, but Moodle sent us to the enrolment page: this course is not available to the user. */
export class NotEnrolled extends Error {
  constructor(url?: string) {
    super(`Not enrolled in this course (landed on ${url ? redactUrl(url) : 'the enrolment page'})`);
    this.name = 'NotEnrolled';
  }
}
