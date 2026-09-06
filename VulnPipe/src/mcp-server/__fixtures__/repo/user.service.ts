/**
 * Piège volontaire : `findById` existe AUSSI ici. La désambiguïsation doit se
 * faire par `injected_type` (OrderService vs UserService), pas par nom de
 * méthode — sinon `resolution_status` passerait à "ambiguous" à tort.
 */
export class UserService {
  async findById(id: string) {
    return this.db.users.findOne({ id });
  }
}
