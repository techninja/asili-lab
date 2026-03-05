/**
 * Format large numbers with K/M suffixes
 */
export function formatNumber(num) {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(0)}K`;
  }
  return num.toString();
}

/**
 * Format throughput (variants/sec) with K suffix
 */
export function formatThroughput(num) {
  if (num >= 1000) {
    return `${(num / 1000).toFixed(0)}K/sec`;
  }
  return `${num}/sec`;
}
