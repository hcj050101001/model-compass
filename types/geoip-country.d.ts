declare module "geoip-country" {
  export interface LookupResult {
    range: [number, number];
    country: string;
  }
  export function lookup(ip: string | number): LookupResult | null;
}
