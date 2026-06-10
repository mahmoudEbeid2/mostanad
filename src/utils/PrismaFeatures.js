export class PrismaFeatures {
  constructor(model, queryString) {
    this.model = model;
    this.queryString = queryString;

    this.queryOptions = {
      where: {},
    };
  }

  //  SEARCH (OR)
  search(fields = []) {
    if (this.queryString.search) {
      this.queryOptions.where.OR = fields.map((field) => ({
        [field]: {
          contains: this.queryString.search,
          mode: "insensitive",
        },
      }));
    }

    return this;
  }

  //  FILTERS (exact match)
  filter() {
    const excludedFields = ["page", "limit", "sort", "search"];

    const filters = { ...this.queryString };

    excludedFields.forEach((field) => delete filters[field]);

    // Automatically convert common types like booleans
    Object.keys(filters).forEach((key) => {
      if (filters[key] === "true") filters[key] = true;
      if (filters[key] === "false") filters[key] = false;
    });

    this.queryOptions.where = {
      ...this.queryOptions.where,
      ...filters,
    };

    return this;
  }

  //  SORT
  sort() {
    if (this.queryString.sort) {
      const orderBy = this.queryString.sort.split(",").map((field) => {
        if (field.startsWith("-")) {
          return { [field.slice(1)]: "desc" };
        }
        return { [field]: "asc" };
      });

      this.queryOptions.orderBy = orderBy;
    } else {
      this.queryOptions.orderBy = {
        createdAt: "desc",
      };
    }

    return this;
  }

  //  PAGINATION
  paginate() {
    const page = Number(this.queryString.page) || 1;
    const limit = Number(this.queryString.limit) || 10;

    const skip = (page - 1) * limit;

    this.queryOptions.skip = skip;
    this.queryOptions.take = limit;

    return this;
  }

  //  EXECUTE QUERY
  async exec() {
    const page = Number(this.queryString.page) || 1;
    const limit = Number(this.queryString.limit) || 10;

    const [data, total] = await Promise.all([
      this.model.findMany(this.queryOptions),
      this.model.count({ where: this.queryOptions.where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
