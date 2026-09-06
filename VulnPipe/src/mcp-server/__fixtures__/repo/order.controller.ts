@Controller('orders')
export class OrderController {
  constructor(
    private orderService: OrderService,
    private logger: LoggerService,
  ) {}

  @UseGuards(OwnershipGuard)
  @Get('/:id')
  async getOrder(@Param('id') id: string, @Req() req: Request) {
    this.logger.log('Fetching order');
    return this.orderService.findById(id);
  }

  @Get('/public/:id')
  async getPublicOrder(@Param('id') id: string) {
    return this.orderService.findPublicById(id);
  }

  @Delete('/:id')
  async deleteOrder(@Param('id') id: string) {
    return this.orderService.findById(id);
  }
}
