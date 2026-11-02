import { randomUUID } from 'node:crypto';

export class Lease {
  id = '';
  private acknowledged = 0;
  private checked = 0;
  private expired = false;
  constructor(readonly timeout: number, readonly now = () => performance.now()) {
    this.acknowledged = this.checked = now();
  }
  connect() {
    if (this.expired) throw new Error('The helper is shutting down.');
    this.id = randomUUID(); this.acknowledged = this.now(); return this.id;
  }
  acknowledge(id: string) {
    if (this.expired || !id || id !== this.id) throw new Error('The window connection has expired.');
    this.acknowledged = this.now();
  }
  release(id: string) { this.acknowledge(id); this.expired = true; }
  check() {
    const now = this.now();
    // A suspended helper cannot observe its window. Allow reconnection after wake.
    if (now - this.checked > this.timeout * 2 && !this.expired) this.acknowledged = now;
    this.checked = now;
    if (now - this.acknowledged >= this.timeout) this.expired = true;
    return this.expired;
  }
}
