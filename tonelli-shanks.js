/**
 * Tonelli-Shanks algorithm for solving x^2 ≡ n (mod p)
 * where p is an odd prime and n is a quadratic residue modulo p
 */

// Legendre symbol: (n|p) = n^((p-1)/2) mod p
// Returns 1 if n is quadratic residue, -1 if not, 0 if n ≡ 0 (mod p)
function legendreSymbol(n, p) {
  const ls = BigInt(n) ** ((BigInt(p) - 1n) / 2n) % BigInt(p);
  if (ls === 1n) return 1;
  if (ls === BigInt(p) - 1n) return -1;
  return 0;
}

// Tonelli-Shanks algorithm
function tonelliShanks(n, p) {
  n = BigInt(n);
  p = BigInt(p);

  // Check if n is a quadratic residue
  if (legendreSymbol(n, p) !== 1) {
    throw new Error(`${n} is not a quadratic residue modulo ${p}`);
  }

  // Factor p-1 into Q * 2^S where Q is odd
  let Q = p - 1n;
  let S = 0n;
  while (Q % 2n === 0n) {
    Q /= 2n;
    S++;
  }

  // Find a quadratic non-residue z
  let z = 2n;
  while (legendreSymbol(z, p) !== -1) {
    z++;
  }

  let c = z ** Q % p;
  let x = n ** ((Q + 1n) / 2n) % p;
  let t = n ** Q % p;
  let m = S;

  while (t !== 1n) {
    // Find the lowest i such that t^(2^i) ≡ 1 (mod p)
    let i = 0n;
    let temp = t;
    while (temp !== 1n && i < m) {
      temp = (temp * temp) % p;
      i++;
    }

    if (i === m) {
      throw new Error('Tonelli-Shanks failed');
    }

    let b = c ** (2n ** (m - i - 1n)) % p;
    x = (x * b) % p;
    t = (t * b * b) % p;
    c = (b * b) % p;
    m = i;
  }

  return x;
}

// Test with known values
const primes = [89443, 90174, 93740];

// For testing: if we have a magic number, we can solve it
function solveQuadratic(magic, prime) {
  try {
    const x = tonelliShanks(magic, BigInt(prime));
    return x;
  } catch (e) {
    console.error(`Failed to solve for prime ${prime}:`, e.message);
    return null;
  }
}

// Export for use in other scripts
module.exports = { tonelliShanks, legendreSymbol, solveQuadratic };

// Test
if (require.main === module) {
  console.log('Tonelli-Shanks solver loaded successfully');
  console.log('Available primes:', primes);
  
  // Test with a simple case: 4 is a quadratic residue mod any prime
  const testResult = solveQuadratic(4, 89443);
  console.log('Test: sqrt(4) mod 89443 =', testResult.toString());
  console.log('Verification:', (testResult * testResult) % 89443n);
}
