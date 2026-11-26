// A local MOCK of WeCom's AI bot long connection (not WeCom): takes one subscription, records every
// frame, and answers each request as the test says. Loopback only.
import { once } from 'node:events'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { z } from 'zod'

const MockWecomFrame = z.object({
  cmd: z.string().optional(),
  headers: z.object({ req_id: z.string().optional() }).optional(),
  body: z.unknown().optional()
})
export type MockWecomFrame = z.infer<typeof MockWecomFrame>

/** How the mock answers one request: an errcode, or no answer at all. */
export type MockWecomAnswer = number | 'silent'

export class MockWecomServer {
  readonly frames: MockWecomFrame[] = []
  answer: (frame: MockWecomFrame) => MockWecomAnswer = () => 0
  private peer: WebSocket | null = null
  private readonly waiters: (() => void)[] = []

  private constructor(private readonly server: WebSocketServer) {
    server.on('connection', (peer) => {
      this.peer = peer
      peer.on('message', (data: RawData) => this.received(peer, data))
    })
  }

  static async start(): Promise<MockWecomServer> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    return new MockWecomServer(server)
  }

  get url(): string {
    const address = this.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('The mock WeCom server has no TCP address')
    }
    return `ws://127.0.0.1:${address.port}`
  }

  /** Requests of one command, in the order they came. */
  sent(cmd: string): MockWecomFrame[] {
    return this.frames.filter((frame) => frame.cmd === cmd)
  }

  /** Resolves once a frame matching `test` has come. */
  async until(test: (frame: MockWecomFrame) => boolean): Promise<MockWecomFrame> {
    for (;;) {
      const found = this.frames.find(test)
      if (found) {
        return found
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  /** A frame WeCom would send unasked: a message callback or an event. */
  push(cmd: string, body: unknown, reqId = `mock_${this.frames.length}`): void {
    this.peer?.send(JSON.stringify({ cmd, headers: { req_id: reqId }, body }))
  }

  dropConnection(): void {
    this.peer?.terminate()
  }

  async stop(): Promise<void> {
    for (const client of this.server.clients) {
      client.terminate()
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private received(peer: WebSocket, data: RawData): void {
    let frame: MockWecomFrame
    try {
      frame = MockWecomFrame.parse(JSON.parse(data.toString()))
    } catch {
      return
    }
    this.frames.push(frame)
    for (const wake of this.waiters.splice(0)) {
      wake()
    }
    const reqId = frame.headers?.req_id
    if (!reqId || frame.cmd === 'ping') {
      if (reqId) {
        peer.send(JSON.stringify({ headers: { req_id: reqId }, errcode: 0 }))
      }
      return
    }
    const errcode = this.answer(frame)
    if (errcode !== 'silent') {
      peer.send(JSON.stringify({ headers: { req_id: reqId }, errcode, errmsg: 'mock' }))
    }
  }
}
