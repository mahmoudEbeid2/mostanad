/**
 * Excludes specified keys from an object.
 * 
 * @param {object} obj - The source object
 * @param {string[]} keys - Keys to exclude
 * @returns {object} A new object without the specified keys
 */
export const excludeFields = (obj, keys) => {
  if (!obj) return null;
  const newObj = { ...obj };
  keys.forEach((key) => delete newObj[key]);
  return newObj;
};
