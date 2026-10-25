export interface DriveRealm { id: string; fileId: string; accountId: string; secret: string }
export interface CryptoOptions { crypto?: Crypto }
export interface RealmOptions extends CryptoOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxPages?: number;
  settleAttempts?: number;
  settleDelayMs?: number;
  signal?: AbortSignal;
}
export interface RealmPacket { v: 1; nonce: string; ciphertext: string }
export interface PacketOptions extends CryptoOptions { maxPacketBytes?: number }
export interface AccountPeerFields {
  accountId: string;
  hostId: string;
  viewerId: string;
  connectionId: string;
  challenge: string;
  issuedAt: number;
  counter?: number;
  purpose: 'connect' | 'keepalive';
}
export interface AccountPeerProof extends AccountPeerFields { proof: string }
export interface ProofVerifyOptions extends CryptoOptions {
  expected?: Partial<Pick<AccountPeerFields, 'accountId' | 'hostId' | 'viewerId' | 'connectionId' | 'challenge' | 'purpose'>>;
  expectedAccountId?: string;
  expectedHostId?: string;
  expectedViewerId?: string;
  expectedConnectionId?: string;
  expectedChallenge?: string;
  expectedPurpose?: AccountPeerFields['purpose'];
  /** Exclusive lower bound: the receiver's last accepted counter. */
  minCounter?: number;
  now?: number | (() => number);
  maxAgeMs?: number;
  clockSkewMs?: number;
}
export function obtainDriveRealm(accessToken: string, profile: { id: string }, options?: RealmOptions): Promise<DriveRealm>;
export function deriveRealmTopic(secret: string, options?: CryptoOptions): Promise<string>;
export function encryptRealmPacket(secret: string, channel: string, payload: unknown, options?: PacketOptions): Promise<RealmPacket>;
export function decryptRealmPacket(secret: string, channel: string, packet: unknown, options?: PacketOptions): Promise<unknown>;
export function createAccountPeerProof(secret: string, fields: AccountPeerFields, options?: CryptoOptions): Promise<AccountPeerProof>;
export function verifyAccountPeerProof(secret: string, packet: unknown, options?: ProofVerifyOptions): Promise<boolean>;
