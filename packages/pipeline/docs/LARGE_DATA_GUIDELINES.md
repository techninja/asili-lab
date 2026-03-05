# Large Data Handling Guidelines

## Critical: Avoid Stack Overflow with Large Arrays

When working with genomic data (80M+ variants), standard JavaScript patterns can cause **Maximum call stack size exceeded** errors.

### ❌ NEVER USE: Spread Operators with Large Arrays

```javascript
// WRONG - Causes stack overflow with large arrays
array.push(...largeArray);
merged = [...array1, ...array2];
func(...largeArray);
```

### ✅ ALWAYS USE: Array Methods

```javascript
// CORRECT - Safe for any array size
array = array.concat(largeArray);
merged = array1.concat(array2);
```

### ❌ NEVER USE: Object.entries() / Object.fromEntries() on Large Objects

```javascript
// WRONG - Creates huge intermediate arrays
for (const [key, value] of Object.entries(hugeObject)) { }
const obj = Object.fromEntries(hugeMap);
```

### ✅ ALWAYS USE: for...in or Manual Serialization

```javascript
// CORRECT - No intermediate arrays
for (const key in hugeObject) {
  if (hugeObject.hasOwnProperty(key)) {
    const value = hugeObject[key];
  }
}

// For Maps, serialize manually
const array = [];
for (const [key, value] of map) {
  array.push([key, value]);
}
```

## Worker Thread Communication

Worker threads cannot transfer Maps/Sets directly. They serialize to empty objects.

### ❌ WRONG
```javascript
parentPort.postMessage({ data: myMap });
```

### ✅ CORRECT
```javascript
const array = [];
for (const [key, value] of myMap) {
  array.push([key, value]);
}
parentPort.postMessage({ data: array });
```

## Why This Matters

- **Spread operators** expand all elements as individual function arguments on the call stack
- JavaScript call stacks are typically limited to ~10,000-50,000 frames
- With 80M variants, spread operators try to create 80M stack frames → instant crash
- `concat()` operates on the heap, not the stack, so it's safe for any size

## Testing Large Data

Always test with real-world genomic datasets (10M+ variants) before deploying. Small test datasets won't reveal these issues.
