export class ReportService {
  async findById(id: string) {
    return this.db.reports.findOne({ id });
  }
}
