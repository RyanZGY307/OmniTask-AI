import { randomUUID } from 'crypto';

export interface QueueUpdateInfo {
  position: number;
  totalInQueue: number;
  estimatedWaitSeconds: number;
}

export interface QueueWaitOptions {
  userId: string;
  requestId?: string;
  onQueueUpdate?: (info: QueueUpdateInfo) => void;
  signal?: AbortSignal;
}

export interface QueueTicket {
  release: () => void;
}

interface QueueItem {
  id: string;
  userId: string;
  enqueuedAt: number;
  onQueueUpdate?: (info: QueueUpdateInfo) => void;
  timer: NodeJS.Timeout;
  resolve: (ticket: QueueTicket) => void;
  reject: (err: Error) => void;
}

class ChatQueueManager {
  // Global maximum concurrent AI generations to maintain responsiveness
  private maxConcurrent = 6;
  // Maximum active generation per individual user
  private maxPerUserConcurrent = 1;
  // Maximum queue capacity before rejection
  private maxQueueCapacity = 100;
  // Timeout for waiting in queue (60 seconds)
  private queueTimeoutMs = 60000;
  // Estimated average generation duration for wait calculations (4 seconds)
  private avgDurationSec = 4;

  private activeGlobalCount = 0;
  private userActiveCount = new Map<string, number>();
  private queue: QueueItem[] = [];
  private updateInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startPeriodicBroadcast();
  }

  /**
   * Acquire an execution slot or wait in queue with status updates.
   */
  public async acquireSlot(options: QueueWaitOptions): Promise<QueueTicket> {
    const { userId, onQueueUpdate, signal } = options;

    // Check if slot is immediately available
    const userActive = this.userActiveCount.get(userId) || 0;
    if (this.activeGlobalCount < this.maxConcurrent && userActive < this.maxPerUserConcurrent) {
      this.activeGlobalCount++;
      this.userActiveCount.set(userId, userActive + 1);
      return {
        release: () => this.releaseSlot(userId),
      };
    }

    // High server load or user concurrency cap reached -> enter queue
    if (this.queue.length >= this.maxQueueCapacity) {
      throw new Error('服务器当前排队人数已满，请稍后再试');
    }

    return new Promise<QueueTicket>((resolve, reject) => {
      // Abort signal listener
      const onAbort = () => {
        this.removeFromQueue(itemId);
        reject(new Error('请求已取消'));
      };

      if (signal?.aborted) {
        return reject(new Error('请求已取消'));
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      // Queue timeout timer
      const itemId = randomUUID();
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        this.removeFromQueue(itemId);
        reject(new Error('服务器高负载，排队等待超时，请稍后重试'));
      }, this.queueTimeoutMs);

      const item: QueueItem = {
        id: itemId,
        userId,
        enqueuedAt: Date.now(),
        onQueueUpdate,
        timer,
        resolve: (ticket) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(ticket);
        },
        reject: (err) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
      };

      this.queue.push(item);

      // Send immediate initial queue update
      this.notifyItem(item);
    });
  }

  /**
   * Release an acquired slot and dispatch the next eligible item in queue.
   */
  private releaseSlot(userId: string): void {
    this.activeGlobalCount = Math.max(0, this.activeGlobalCount - 1);
    const userActive = this.userActiveCount.get(userId) || 1;
    if (userActive <= 1) {
      this.userActiveCount.delete(userId);
    } else {
      this.userActiveCount.set(userId, userActive - 1);
    }

    this.processNextInQueue();
  }

  /**
   * Process the next eligible queue item.
   */
  private processNextInQueue(): void {
    if (this.activeGlobalCount >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    // Find the first item whose user is not exceeding the per-user concurrency limit
    const index = this.queue.findIndex((item) => {
      const userActive = this.userActiveCount.get(item.userId) || 0;
      return userActive < this.maxPerUserConcurrent;
    });

    if (index === -1) return;

    const [item] = this.queue.splice(index, 1);
    this.activeGlobalCount++;
    const userActive = this.userActiveCount.get(item.userId) || 0;
    this.userActiveCount.set(item.userId, userActive + 1);

    item.resolve({
      release: () => this.releaseSlot(item.userId),
    });

    // Notify remaining queue items of their new positions
    this.broadcastQueuePositions();
  }

  /**
   * Remove item from queue without allocating a slot.
   */
  private removeFromQueue(itemId: string): void {
    const index = this.queue.findIndex((item) => item.id === itemId);
    if (index !== -1) {
      const [item] = this.queue.splice(index, 1);
      clearTimeout(item.timer);
      this.broadcastQueuePositions();
    }
  }

  /**
   * Calculate position and estimated wait time for an item.
   */
  private getItemInfo(item: QueueItem): QueueUpdateInfo {
    const position = this.queue.indexOf(item) + 1;
    const totalInQueue = this.queue.length;
    const estimatedWaitSeconds = Math.max(
      1,
      Math.ceil((position * this.avgDurationSec) / Math.max(1, this.maxConcurrent))
    );
    return { position, totalInQueue, estimatedWaitSeconds };
  }

  private notifyItem(item: QueueItem): void {
    try {
      const info = this.getItemInfo(item);
      item.onQueueUpdate?.(info);
    } catch {}
  }

  private broadcastQueuePositions(): void {
    for (const item of this.queue) {
      this.notifyItem(item);
    }
  }

  private startPeriodicBroadcast(): void {
    if (this.updateInterval) return;
    this.updateInterval = setInterval(() => {
      if (this.queue.length > 0) {
        this.broadcastQueuePositions();
      }
    }, 2500);
    this.updateInterval.unref?.();
  }

  public getStats() {
    return {
      activeGlobalCount: this.activeGlobalCount,
      queuedCount: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueueCapacity: this.maxQueueCapacity,
    };
  }
}

export const chatQueue = new ChatQueueManager();
