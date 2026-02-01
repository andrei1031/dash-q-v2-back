const Filter = require('bad-words');

const tagalogBadWords = [
  'gago',
  'putangina',
  'bobo',
  'tangina',
  'ina mo',
  'tanga',
  'kupal',
];

const filter = new Filter();
filter.addWords(...tagalogBadWords);

module.exports = filter;
