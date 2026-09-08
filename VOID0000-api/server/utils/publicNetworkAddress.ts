import { BlockList, isIP } from 'node:net';

const ipv4 = new BlockList();
ipv4.addSubnet('0.0.0.0', 0, 'ipv4');
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) blocked.addSubnet(address, prefix, 'ipv6');

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (!family || address.includes('%')) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  // BlockList compares binary addresses, including dotted/hex IPv4-mapped IPv6.
  return (ipv4.check(address, type) || globalIPv6.check(address, type)) &&
    !blocked.check(address, type);
}
