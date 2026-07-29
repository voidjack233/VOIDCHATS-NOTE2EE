export const createSingleFlightValue = <T>() => {
  let value: T | null = null;
  let inFlight: Promise<T | null> | null = null;
  let generation = 0;

  return {
    getCached(): T | null {
      return value;
    },
    getOrLoad(load: () => Promise<T | null>): Promise<T | null> {
      if (value !== null) {
        return Promise.resolve(value);
      }
      if (inFlight) {
        return inFlight;
      }

      const requestGeneration = generation;
      const request = load()
        .then((nextValue) => {
          if (generation !== requestGeneration) {
            return null;
          }
          if (nextValue !== null) {
            value = nextValue;
          }
          return nextValue;
        })
        .finally(() => {
          if (inFlight === request) {
            inFlight = null;
          }
        });
      inFlight = request;
      return request;
    },
    clear(): void {
      generation += 1;
      value = null;
      inFlight = null;
    },
  };
};
